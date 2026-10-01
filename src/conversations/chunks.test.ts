import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { Message } from "../domain/models.js"
import type { SendGuard } from "../sends/guard.js"
import { conversationsService } from "../services/conversations.js"
import { storedDeps } from "../services/deps.js"
import { openStore } from "../store/store.js"
import { chunkHash, cutChunks } from "./chunks.js"

describe("cutChunks", () => {
  it("**cuts a conversation at message boundaries**, each chunk within the limit", () => {
    const lines = [
      { id: "1", sender: "Ana", text: "a".repeat(10) },
      { id: "2", sender: "Bo", text: "b".repeat(10) },
      { id: "3", sender: null, text: "c".repeat(10) },
    ]
    const chunks = cutChunks(lines, 30)
    expect(chunks.map(({ firstId, lastId, text }) => [firstId, lastId, text])).toEqual([
      ["1", "2", `Ana: ${"a".repeat(10)}\nBo: ${"b".repeat(10)}`],
      ["3", "3", "c".repeat(10)],
    ])
    expect(chunks[0]?.hash).toBe(chunkHash(chunks[0]?.text ?? ""))
  })

  it("keeps a message longer than the limit whole, alone, and skips messages with no text", () => {
    const chunks = cutChunks(
      [
        { id: "1", sender: null, text: "short" },
        { id: "2", sender: null, text: "x".repeat(50) },
        { id: "3", sender: null, text: "  " },
      ],
      20,
    )
    expect(chunks.map(({ firstId, lastId }) => [firstId, lastId])).toEqual([
      ["1", "1"],
      ["2", "2"],
    ])
    expect(cutChunks([{ id: "1", sender: null, text: "" }])).toEqual([])
  })
})

const account = { provider: "test", account: "1" }

const message = (id: string, text: string, replyToId?: string): Message => ({
  id,
  chatId: "9",
  senderId: "100",
  senderName: "Ana",
  timestamp: new Date(Date.parse("2026-10-01T00:00:00Z") + Number(id) * 3_600_000).toISOString(),
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  ...(replyToId ? { replyToId } : {}),
  forwardedFrom: null,
  reactions: null,
})

const chunkRows = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return db
      .prepare(
        `SELECT f.native_id AS first, l.native_id AS last, k.content_hash AS hash FROM conversation_chunks k
         JOIN conversations c ON c.pk = k.conversation_pk
         JOIN conversation_state s ON s.chat_pk = c.chat_pk AND s.current_build = c.build
         JOIN messages f ON f.pk = k.first_message_pk JOIN messages l ON l.pk = k.last_message_pk
         ORDER BY f.sent_at`,
      )
      .all() as { first: string; last: string; hash: string }[]
  } finally {
    db.close()
  }
}

describe("chunks in a build", () => {
  it("**are written with each build**; a rebuild keeps every hash, an edit changes only its chunk's", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "chunks-")), "m.db")
    const store = await openStore({ path })
    await store.saveChats(account, [
      { id: "9", title: "Group", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
    ])
    await store.saveMessages(
      account,
      "9",
      [message("1", "where do we meet"), message("2", "at the station", "1"), message("40", "new topic")],
      { via: "history" },
    )
    const conversations = conversationsService(
      storedDeps({ provider: "test", app: { command: "chat" } } as Messenger, store, account, {} as SendGuard),
    )

    await conversations.build("9")
    const first = chunkRows(path)
    expect(first.map(({ first, last }) => [first, last])).toEqual([
      ["1", "2"],
      ["40", "40"],
    ])
    expect(first[0]?.hash).toBe(chunkHash("Ana: where do we meet\nAna: at the station"))

    await conversations.build("9")
    expect(chunkRows(path)).toEqual(first)

    await store.saveMessages(
      account,
      "9",
      [{ ...message("40", "a new topic"), editedAt: "2026-10-03T00:00:00.000Z" }],
      {
        via: "history",
      },
    )
    await conversations.build("9")
    const edited = chunkRows(path)
    expect(edited[0]).toEqual(first[0])
    expect(edited[1]?.hash).not.toBe(first[1]?.hash)
    await store.close()
  })
})
