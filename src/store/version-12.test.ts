import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Chat, Message } from "../domain/models.js"
import type { CacheDatabase } from "./driver.js"
import { MIGRATIONS, migrate } from "./migrations.js"
import { openCache } from "./open.js"
import { backfillNormalized } from "./sqlite/backfill.js"
import { type AccountKey, BACKFILL_ON_OPEN, openStore } from "./store.js"

const fresh = () => join(mkdtempSync(join(tmpdir(), "v12-")), "messages.db")
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

const message = (id: string, text: string, senderId: string | null = "7"): Message => ({
  id,
  chatId: CHAT,
  senderId,
  senderName: senderId === null ? null : "Ana",
  timestamp: "2026-09-26T10:00:00.000Z",
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const withDatabase = async <T>(path: string, use: (database: CacheDatabase) => T): Promise<T> => {
  const database = await openCache(path)
  try {
    return use(database)
  } finally {
    database.close()
  }
}

const matching = (database: CacheDatabase, query: string): number[] =>
  database
    .prepare("SELECT rowid FROM message_words WHERE message_words MATCH ? ORDER BY rowid")
    .all(query)
    .map((row) => Number(row.rowid))

const state = (database: CacheDatabase) =>
  database.prepare("SELECT watermark, filled_through, built_at FROM search_index_state").get()

const integrityCheck = (database: CacheDatabase) =>
  database.exec("INSERT INTO message_words (message_words, rank) VALUES ('integrity-check', 1)")

/** A file as version 11 left it: `count` messages `w<pk>` in one chat, those in `unnormalized` not yet normalized. */
const version11 = async (count: number, unnormalized: number[] = []): Promise<string> => {
  const waiting = `i IN (${unnormalized.join(", ")})`
  const path = fresh()
  await withDatabase(path, (database) => {
    migrate(database, { migrations: MIGRATIONS.filter(({ version }) => version <= 11) })
    database.exec(`INSERT INTO accounts (pk, provider, native_id, created_at) VALUES (1, 'telegram', '100', 0)`)
    database.exec(
      `INSERT INTO chats (pk, account_pk, native_id, kind, updated_at) VALUES (1, 1, '${CHAT}', 'group', 0)`,
    )
    database.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
      INSERT INTO messages (pk, chat_pk, account_pk, native_id, sent_at, text, normalized_text, normalizer_version,
                            ingested_at, ingested_via)
      SELECT i, 1, 1, CAST(i AS TEXT), i, 'W' || i,
             CASE WHEN ${waiting} THEN NULL ELSE 'w' || i END,
             CASE WHEN ${waiting} THEN NULL ELSE 1 END, 0, 'history' FROM n`)
  })
  return path
}

describe("store version 12, the word index", () => {
  it("**fills a file of BACKFILL_ON_OPEN messages** during the migration, and marks it built", async () => {
    const path = await version11(BACKFILL_ON_OPEN)
    await (await openStore({ path })).close()

    await withDatabase(path, (database) => {
      expect(state(database)).toMatchObject({ watermark: BACKFILL_ON_OPEN, filled_through: BACKFILL_ON_OPEN })
      expect(state(database)?.built_at).toEqual(expect.any(Number))
      expect(matching(database, "normalized_text: w1")).toEqual([1])
      expect(matching(database, `normalized_text: w${BACKFILL_ON_OPEN}`)).toEqual([BACKFILL_ON_OPEN])
    })
  })

  it("**leaves a larger file to the batches**, with the watermark where they stop", async () => {
    const path = await version11(BACKFILL_ON_OPEN + 1)
    await withDatabase(path, (database) => migrate(database))

    await withDatabase(path, (database) => {
      expect(state(database)).toEqual({ watermark: BACKFILL_ON_OPEN + 1, filled_through: 0, built_at: null })
      expect(matching(database, "normalized_text: w1")).toEqual([])
    })
  })

  it("**stays consistent when filled after its triggers** — edits, tombstones and backfill on both sides of the fill", async () => {
    const count = BACKFILL_ON_OPEN + 10
    const half = count / 2
    const path = await version11(count, [6, half + 6])
    const fill = (database: CacheDatabase, from: number, to: number) =>
      database
        .prepare(`INSERT OR REPLACE INTO message_words (rowid, normalized_text, scope)
          SELECT pk, normalized_text, 'c' || chat_pk || coalesce(' s' || sender_identity_pk, '')
          FROM messages WHERE normalized_text IS NOT NULL AND pk BETWEEN ? AND ?`)
        .run(from, to)

    await withDatabase(path, (database) => {
      migrate(database)
      fill(database, 1, half)
      for (const pk of [2, half + 2])
        database.exec(`UPDATE messages SET normalized_text = 'edited${pk}' WHERE pk = ${pk}`)
      for (const pk of [3, half + 3]) {
        database.exec(`UPDATE messages SET deleted_at = 1, text = '', normalized_text = NULL WHERE pk = ${pk}`)
      }
      for (const pk of [4, half + 4]) {
        database.exec(`UPDATE messages SET deleted_at = 1, text = '', normalized_text = NULL WHERE pk = ${pk}`)
        database.exec(
          `UPDATE messages SET deleted_at = NULL, text = 'Back', normalized_text = 'back${pk}' WHERE pk = ${pk}`,
        )
      }
      for (const pk of [5, half + 5]) database.exec(`DELETE FROM messages WHERE pk = ${pk}`)
      backfillNormalized(database)
      integrityCheck(database)
      fill(database, half + 1, count)
      integrityCheck(database)

      const live = database
        .prepare("SELECT pk, normalized_text AS words FROM messages WHERE deleted_at IS NULL ORDER BY pk")
        .all()
      expect(live).toHaveLength(count - 4)
      for (const pk of [6, half + 6]) expect(matching(database, `normalized_text: w${pk}`)).toEqual([pk])
      for (const { pk, words } of live) expect(matching(database, `normalized_text: ${String(words)}`)).toEqual([pk])
      for (const pk of [2, 3, 5, half + 2, half + 3, half + 5]) expect(matching(database, `w${pk}`)).toEqual([])
    })
  })

  it("**follows every write of the store**: a new message, an edit, a sender learned later, a deletion and its undoing, a purge", async () => {
    const path = fresh()
    const store = await openStore({ path })
    await store.saveChats(ME, [chat])
    await store.saveMessages(ME, CHAT, [message("1", "квартира в Валенсии", null), message("2", "tiempo")], {
      via: "history",
    })
    const pkOf = (database: CacheDatabase, id: string) =>
      Number(database.prepare("SELECT pk FROM messages WHERE native_id = ?").get(id)?.pk)
    const sender = await withDatabase(path, (database) =>
      Number(database.prepare("SELECT sender_identity_pk AS pk FROM messages WHERE native_id = '2'").get()?.pk),
    )

    await withDatabase(path, (database) => {
      expect(matching(database, "normalized_text: квартира")).toEqual([pkOf(database, "1")])
      expect(matching(database, `scope: s${sender}`)).toEqual([pkOf(database, "2")])
    })

    await store.saveMessages(ME, CHAT, [message("1", "квартира в Валенсии"), message("2", "mañana")], {
      via: "history",
    })
    await withDatabase(path, (database) => {
      expect(matching(database, `scope: s${sender}`)).toEqual([pkOf(database, "1"), pkOf(database, "2")])
      expect(matching(database, "normalized_text: tiempo")).toEqual([])
      expect(matching(database, "normalized_text: manana")).toEqual([pkOf(database, "2")])
    })

    await store.markDeleted(ME, ["2"], { chatId: CHAT })
    await withDatabase(path, (database) => expect(matching(database, "normalized_text: manana")).toEqual([]))
    await store.saveMessages(ME, CHAT, [message("2", "mañana")], { via: "history", seenAt: Date.now() + 1_000 })
    await withDatabase(path, (database) =>
      expect(matching(database, "normalized_text: manana")).toEqual([pkOf(database, "2")]),
    )

    await store.purge(ME)
    await store.close()
    await withDatabase(path, (database) => {
      expect(matching(database, "normalized_text: manana OR квартира")).toEqual([])
      integrityCheck(database)
    })
  })

  it("**is not touched by re-saving a message unchanged**", async () => {
    const path = fresh()
    const store = await openStore({ path })
    await store.saveChats(ME, [chat])
    await store.saveMessages(ME, CHAT, [message("1", "квартира")], { via: "history" })
    // Without merging, any delete and insert leaves a new segment behind.
    await withDatabase(path, (database) =>
      database.exec("INSERT INTO message_words (message_words, rank) VALUES ('automerge', 0)"),
    )
    const index = () =>
      withDatabase(path, (database) =>
        database
          .prepare("SELECT CAST(id AS TEXT) AS id, hex(block) AS block FROM message_words_data ORDER BY id")
          .all(),
      )
    const before = await index()

    await store.saveMessages(ME, CHAT, [message("1", "квартира")], { via: "history" })
    expect(await index()).toEqual(before)
    await store.saveMessages(ME, CHAT, [message("1", "квартиру")], { via: "history" })
    expect(await index()).not.toEqual(before)
    await store.close()
  })

  it("**leaves a message without text out**: a photo with no caption has no words to find", async () => {
    const path = fresh()
    const store = await openStore({ path })
    await store.saveChats(ME, [chat])
    await store.saveMessages(ME, CHAT, [message("1", "")], { via: "history" })
    await store.close()

    await withDatabase(path, (database) => expect(matching(database, "scope: c1")).toEqual([]))
  })

  it("**indexes what an older build writes** into the migrated file", async () => {
    const path = await version11(1)
    await (await openStore({ path })).close()

    await withDatabase(path, (database) => {
      database.exec(`INSERT INTO messages (chat_pk, account_pk, native_id, sent_at, text, normalized_text,
                       normalizer_version, ingested_at, ingested_via)
                     VALUES (1, 1, '2', 2, 'Viejo', 'viejo', 1, 0, 'history')`)
      expect(matching(database, "normalized_text: viejo")).toEqual([2])
    })
  })

  it("**keeps the scope tokens out of the words** in its vocabulary", async () => {
    const path = await version11(2)
    await (await openStore({ path })).close()

    await withDatabase(path, (database) => {
      const words = database
        .prepare("SELECT term FROM message_words_vocab WHERE col = 'normalized_text' ORDER BY term")
        .all()
      expect(words.map(({ term }) => term)).toEqual(["w1", "w2"])
    })
  })

  it("keeps the vocabulary tables WITHOUT ROWID", async () => {
    const path = fresh()
    await (await openStore({ path })).close()

    const tables = await withDatabase(path, (database) =>
      database
        .prepare(
          "SELECT name, sql FROM sqlite_schema WHERE name IN ('search_terms', 'search_term_trigrams') ORDER BY name",
        )
        .all(),
    )
    expect(tables.map(({ name }) => name)).toEqual(["search_term_trigrams", "search_terms"])
    for (const { sql } of tables) expect(String(sql)).toMatch(/WITHOUT ROWID$/)
  })
})
