import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Chat, Message } from "../domain/models.js"
import { MIGRATIONS, migrate } from "./migrations.js"
import { openCache } from "./open.js"
import { backfillNormalized, pendingNormalization } from "./sqlite/backfill.js"
import { type AccountKey, openStore } from "./store.js"

const fresh = () => join(mkdtempSync(join(tmpdir(), "v6-")), "messages.db")
const ME: AccountKey = { provider: "telegram", account: "100" }
const CHAT = "-1001"

const chat: Chat = {
  id: CHAT,
  title: "Valencia expats",
  kind: "group",
  unreadCount: 0,
  lastMessageAt: null,
  participantsCount: null,
}

const message = (id: string, text = `Mensaje ${id} en València`): Message => ({
  id,
  chatId: CHAT,
  senderId: "7",
  senderName: "Ana",
  timestamp: "2026-09-26T10:00:00.000Z",
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const raw = async (path: string, sql: string, ...parameters: (string | number)[]) => {
  const database = await openCache(path)
  try {
    return database.prepare(sql).all(...parameters)
  } finally {
    database.close()
  }
}

/** A file as version 5 left it, with three live messages and one tombstone. */
const version5 = async (): Promise<string> => {
  const path = fresh()
  const database = await openCache(path)
  migrate(database, { migrations: MIGRATIONS.filter(({ version }) => version <= 5) })
  database.exec(`INSERT INTO accounts (pk, provider, native_id, created_at) VALUES (1, 'telegram', '100', 0)`)
  database.exec(`INSERT INTO chats (pk, account_pk, native_id, kind, updated_at) VALUES (1, 1, '${CHAT}', 'group', 0)`)
  for (const [id, deleted] of [
    ["1", null],
    ["2", null],
    ["3", 5],
    ["4", null],
  ]) {
    database.exec(`INSERT INTO messages (chat_pk, account_pk, native_id, sent_at, text, deleted_at, ingested_at, ingested_via)
                   VALUES (1, 1, '${id}', 1, 'Счёт ${id}', ${deleted}, 0, 'history')`)
  }
  database.close()
  return path
}

describe("store version 6", () => {
  it("**counts a chat's live messages** through inserts, tombstones, their undoing and deletes", async () => {
    const path = fresh()
    const store = await openStore({ path })
    await store.saveChats(ME, [chat])
    await store.saveMessages(ME, CHAT, [message("1"), message("2"), message("3")], { via: "history" })
    await store.markDeleted(ME, ["2"], { chatId: CHAT })
    await store.close()
    const count = async () => (await raw(path, "SELECT message_count FROM chats WHERE native_id = ?", CHAT))[0]

    expect(await count()).toEqual({ message_count: 2 })
    await raw(path, "UPDATE messages SET deleted_at = NULL WHERE native_id = '2'")
    expect(await count()).toEqual({ message_count: 3 })
    await raw(path, "DELETE FROM messages WHERE native_id = '1'")
    expect(await count()).toEqual({ message_count: 2 })
  })

  it("**counts what version 5 held** when it upgrades, leaving tombstones out", async () => {
    const path = await version5()
    await (await openStore({ path })).close()

    expect(await raw(path, "SELECT message_count FROM chats")).toEqual([{ message_count: 3 }])
  })

  it("keeps a normalized copy of each saved text, follows an edit, and gives a deleted message none", async () => {
    const path = fresh()
    const store = await openStore({ path })
    await store.saveMessages(ME, CHAT, [message("1"), message("2")], { via: "history" })
    await store.saveMessages(ME, CHAT, [message("1", "Ёжик ﬁnds  it")], { via: "update" })
    await store.markDeleted(ME, ["2"], { chatId: CHAT })
    await raw(path, "UPDATE messages SET normalized_text = NULL WHERE native_id = '2'")
    await store.saveMessages(ME, CHAT, [message("2", "edited after deletion")], { via: "update" })
    await store.close()

    expect(await raw(path, "SELECT native_id, normalized_text, normalizer_version FROM messages ORDER BY pk")).toEqual([
      { native_id: "1", normalized_text: "ежик finds it", normalizer_version: 1 },
      { native_id: "2", normalized_text: null, normalizer_version: 1 },
    ])
  })

  it("keeps a chat's membership, and a list that does not say keeps what was known", async () => {
    const store = await openStore({ path: fresh() })
    await store.saveChats(ME, [{ ...chat, membershipState: "left" }])
    await store.saveChats(ME, [chat])

    expect((await store.chats(ME, {})).items).toEqual([{ ...chat, membershipState: "left" }])
    await store.close()
  })

  it("**fills what version 5 left, a batch at a time, and resumes where a stopped run ended**", async () => {
    const path = await version5()
    const database = await openCache(path)
    migrate(database)
    expect(pendingNormalization(database)).toBe(3)

    expect(() =>
      backfillNormalized(database, {
        batch: 1,
        onBatch: () => {
          throw new Error("stopped")
        },
      }),
    ).toThrow("stopped")
    expect(pendingNormalization(database)).toBe(2)
    expect(backfillNormalized(database, { batch: 1 })).toBe(2)
    expect(pendingNormalization(database)).toBe(0)
    expect(
      database
        .prepare("SELECT native_id, normalized_text FROM messages ORDER BY pk")
        .all()
        .map((row) => ({ ...row })),
    ).toEqual([
      { native_id: "1", normalized_text: "счет 1" },
      { native_id: "2", normalized_text: "счет 2" },
      { native_id: "3", normalized_text: null },
      { native_id: "4", normalized_text: "счет 4" },
    ])
    database.close()
  })

  it("fills a small file on its first open", async () => {
    const path = await version5()
    await (await openStore({ path })).close()

    expect(await raw(path, "SELECT count(*) AS n FROM messages WHERE normalized_text IS NOT NULL")).toEqual([{ n: 3 }])
  })
})

describe("builds already installed, on a version 6 file", () => {
  it.each(["cli-messaging-0.13", "cli-messaging-0.27"])(
    "**%s refuses it and asks to be upgraded**, leaving the file as it was",
    async (build) => {
      const path = fresh()
      await (await openStore({ path })).close()
      const before = readFileSync(path)
      const log = await raw(path, "SELECT version, min_compatible FROM schema_migrations ORDER BY version")

      const { openStore: openOlder } = (await import(`${build}/store`)) as { openStore: typeof openStore }
      await expect(openOlder({ path })).rejects.toMatchObject({
        code: "configuration_error",
        message: expect.stringMatching(/upgrade this tool/),
      })

      expect(readFileSync(path).equals(before)).toBe(true)
      expect(await raw(path, "SELECT version, min_compatible FROM schema_migrations ORDER BY version")).toEqual(log)
    },
  )
})
