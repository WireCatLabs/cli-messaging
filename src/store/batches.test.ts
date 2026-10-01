import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Message } from "../domain/models.js"
import { openCache } from "./open.js"
import { BATCH_CONTEXT } from "./sqlite/batches.js"
import { type AccountKey, openStore } from "./store.js"

const OWNER: AccountKey = { provider: "tg", account: "1" }

const message = (n: number, replyToId?: string): Message => ({
  id: String(n),
  chatId: "-1",
  senderId: String(7 + (n % 3)),
  senderName: null,
  timestamp: new Date(Date.parse("2026-10-01T00:00:00Z") + n * 60_000).toISOString(),
  editedAt: null,
  text: `message ${n}`,
  outgoing: false,
  attachments: [],
  replyTo: null,
  ...(replyToId ? { replyToId } : {}),
  forwardedFrom: null,
  reactions: null,
})

const chatOf = async (count: number, replies: Record<number, number> = {}) => {
  const path = join(mkdtempSync(join(tmpdir(), "batches-")), "messages.db")
  const store = await openStore({ path })
  await store.saveChats(OWNER, [
    { id: "-1", title: "Group", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
  ])
  const all = Array.from({ length: count }, (_, i) =>
    message(i + 1, replies[i + 1] ? String(replies[i + 1]) : undefined),
  )
  await store.saveMessages(OWNER, "-1", all, { via: "history" })
  return { store, path }
}

/** An agent answer for `id`, written as `links add` will write it. */
const answered = async (path: string, id: number, staleAt: number | null = null) => {
  const database = await openCache(path)
  database
    .prepare(
      `INSERT OR REPLACE INTO message_links (chat_pk, message_pk, parent_pk, source, kind, confidence, method, created_at, stale_at)
       SELECT chat_pk, pk, NULL, 'agent', 'answer', 0.9, 'model', 0, ? FROM messages WHERE native_id = ?`,
    )
    .run(staleAt, String(id))
  database.close()
}

const ids = (messages: { id: string; answer: boolean }[], answer: boolean) =>
  messages.filter((one) => one.answer === answer).map(({ id }) => Number(id))

describe("batches for the user's agent", () => {
  it("**cuts a window**: the first unanswered message, the next `size`, and the 50 before it as context", async () => {
    const { store, path } = await chatOf(200)
    for (let id = 1; id <= 120; id++) await answered(path, id)

    const batch = await store.nextBatch(OWNER, "-1", { size: 30 })

    expect(ids(batch?.messages ?? [], true)).toEqual(Array.from({ length: 30 }, (_, i) => 121 + i))
    expect(ids(batch?.messages ?? [], false)).toEqual(Array.from({ length: BATCH_CONTEXT }, (_, i) => 71 + i))
    expect(batch?.batch).toMatch(/^b1\.\d+\.\d+\.\d+\.[0-9a-f]{12}$/)
    expect(batch?.remaining).toEqual({ messages: 50, characters: 50 * "message 1xx".length })
    await store.close()
  })

  it("keeps a message the messenger records as a reply for context, never to answer", async () => {
    const { store } = await chatOf(5, { 3: 2 })

    const batch = await store.nextBatch(OWNER, "-1", { size: 50 })

    expect(ids(batch?.messages ?? [], true)).toEqual([1, 2, 4, 5])
    expect(batch?.messages.find(({ id }) => id === "3")).toMatchObject({ answer: false, replyTo: "2" })
    expect(await store.batchStatus(OWNER, "-1")).toEqual({ messages: 4, characters: 4 * "message 1".length })
    await store.close()
  })

  it("asks again about a message whose answer went stale, and about nothing once all are answered", async () => {
    const { store, path } = await chatOf(3)
    await answered(path, 1)
    await answered(path, 2, 1)
    await answered(path, 3)

    expect(ids((await store.nextBatch(OWNER, "-1", { size: 50 }))?.messages ?? [], true)).toEqual([2])
    await answered(path, 2)
    expect(await store.nextBatch(OWNER, "-1", { size: 50 })).toBeUndefined()
    expect(await store.nextBatch(OWNER, "-404", { size: 50 })).toBeUndefined()
    await store.close()
  })
})
