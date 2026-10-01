import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Message } from "../domain/models.js"
import { openCache } from "./open.js"
import { type AccountKey, openStore } from "./store.js"

const fresh = () => join(mkdtempSync(join(tmpdir(), "conversations-")), "messages.db")
const OWNER: AccountKey = { provider: "tg", account: "1" }

const message = (id: string, replyToId?: string): Message => ({
  id,
  chatId: "-1",
  senderId: "7",
  senderName: "Ana",
  timestamp: `2026-10-01T10:00:0${id}.000Z`,
  editedAt: null,
  text: `message ${id}`,
  outgoing: false,
  attachments: [],
  replyTo: null,
  ...(replyToId ? { replyToId } : {}),
  forwardedFrom: null,
  reactions: null,
})

const withDatabase = async <T>(path: string, body: (run: (sql: string) => Record<string, unknown>[]) => T) => {
  const database = await openCache(path)
  try {
    return body((sql) =>
      database
        .prepare(sql)
        .all()
        .map((row) => ({ ...row })),
    )
  } finally {
    database.close()
  }
}

/** Two messages, the second answering the first, grouped into one conversation of an enabled chat. */
const conversationIn = async (path: string) => {
  const store = await openStore({ path })
  await store.saveChats(OWNER, [
    { id: "-1", title: "Group", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
  ])
  await store.saveMessages(OWNER, "-1", [message("1"), message("2", "1")], { via: "history" })
  await store.close()
  await withDatabase(path, (run) => {
    run(`INSERT INTO message_links (chat_pk, message_pk, parent_pk, source, kind, confidence, method, created_at, build)
         SELECT m.chat_pk, m.pk, p.pk, 'provider', 'reply', 1, 'reply', 0, 1
         FROM messages m JOIN messages p ON p.native_id = '1' WHERE m.native_id = '2'`)
    run(`INSERT INTO message_links (chat_pk, message_pk, parent_pk, source, kind, confidence, method, created_at)
         SELECT chat_pk, pk, NULL, 'agent', 'start', 0.9, 'model', 0 FROM messages WHERE native_id = '1'`)
    run(`INSERT INTO conversations (chat_pk, build, first_message_pk, first_at, last_at, message_count, built_at, algorithm_version)
         SELECT chat_pk, 1, pk, sent_at, sent_at, 2, 0, 2 FROM messages WHERE native_id = '1'`)
    run("INSERT INTO conversation_messages (conversation_pk, message_pk) SELECT 1, pk FROM messages")
    run("INSERT INTO conversation_state (chat_pk, enabled_at, current_build) SELECT pk, 0, 1 FROM chats")
  })
}

const counts = (path: string) =>
  withDatabase(path, (run) =>
    Object.fromEntries(
      ["message_links", "conversations", "conversation_messages", "conversation_state"].map((table) => [
        table,
        Number(run(`SELECT count(*) AS n FROM ${table}`)[0]?.n),
      ]),
    ),
  )

describe("conversation tables (store version 13)", () => {
  it("**go with the account**: a purge removes the messages, and the derived rows follow", async () => {
    const path = fresh()
    await conversationIn(path)
    expect(await counts(path)).toEqual({
      message_links: 2,
      conversations: 1,
      conversation_messages: 2,
      conversation_state: 1,
    })

    const store = await openStore({ path })
    await store.purge(OWNER)
    await store.close()

    expect(await counts(path)).toEqual({
      message_links: 0,
      conversations: 0,
      conversation_messages: 0,
      conversation_state: 0,
    })
    expect(await withDatabase(path, (run) => run("PRAGMA foreign_key_check"))).toEqual([])
  })

  it("hold one link per message, parent, source, kind and build — a start and an agent's link included", async () => {
    const path = fresh()
    await conversationIn(path)
    await withDatabase(path, (run) => {
      expect(() =>
        run(`INSERT INTO message_links (chat_pk, message_pk, parent_pk, source, kind, confidence, method, created_at, build)
             SELECT chat_pk, message_pk, parent_pk, source, kind, 0.5, 'again', 1, build FROM message_links WHERE parent_pk IS NOT NULL`),
      ).toThrow(/UNIQUE/)
      expect(() =>
        run(`INSERT INTO message_links (chat_pk, message_pk, parent_pk, source, kind, confidence, method, created_at)
             SELECT chat_pk, message_pk, NULL, source, kind, 0.5, 'again', 1 FROM message_links WHERE parent_pk IS NULL`),
      ).toThrow(/UNIQUE/)
    })
  })
})

describe("a build on version 6, on a version 13 file", () => {
  it("**keeps reading and writing**: version 13 only adds tables", async () => {
    const path = fresh()
    await conversationIn(path)

    const { openStore: openOlder } = await import("cli-messaging-0.49/store")
    const older = await openOlder({ path })
    await older.saveMessages(OWNER, "-1", [message("3")], { via: "history" })
    expect((await older.messages(OWNER, "-1", { limit: 10 })).items.map(({ id }) => id)).toEqual(["1", "2", "3"])
    await older.close()
  })
})
