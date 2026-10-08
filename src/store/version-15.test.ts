import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Chat, Message } from "../domain/models.js"
import { analyzerIdentity, DEFAULT_STEMMERS } from "../search/stem.js"
import type { CacheDatabase } from "./driver.js"
import { MIGRATIONS, migrate } from "./migrations.js"
import { openCache } from "./open.js"
import { fillStems, resetStems, saveStoreStemmers, stemsState } from "./sqlite/stems.js"
import { type AccountKey, BACKFILL_ON_OPEN, openStore } from "./store.js"

const fresh = () => join(mkdtempSync(join(tmpdir(), "v15-")), "messages.db")
const ME: AccountKey = { provider: "telegram", account: "100" }
const CHAT = "-1001"
const ENGLISH = { cyrillic: "russian", latin: "english" } as const

const chat: Chat = {
  id: CHAT,
  title: "Valencia expats",
  kind: "group",
  unreadCount: 0,
  lastMessageAt: null,
  participantsCount: null,
}

const message = (id: string, text: string): Message => ({
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

const withDatabase = async <T>(path: string, use: (database: CacheDatabase) => T): Promise<T> => {
  const database = await openCache(path)
  try {
    return use(database)
  } finally {
    database.close()
  }
}

const stemmed = (database: CacheDatabase, stem: string): number[] =>
  database
    .prepare("SELECT rowid FROM message_stems WHERE message_stems MATCH ? ORDER BY rowid")
    .all(`stems: ${stem}`)
    .map((row) => Number(row.rowid))

/** A file as version 14 left it: `count` messages in one chat, each `квартиру <pk>`. */
const version14 = async (count: number): Promise<string> => {
  const path = fresh()
  await withDatabase(path, (database) => {
    migrate(database, { migrations: MIGRATIONS.filter(({ version }) => version <= 14) })
    database.exec(`INSERT INTO accounts (pk, provider, native_id, created_at) VALUES (1, 'telegram', '100', 0)`)
    database.exec(
      `INSERT INTO chats (pk, account_pk, native_id, kind, updated_at) VALUES (1, 1, '${CHAT}', 'group', 0)`,
    )
    database.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
      INSERT INTO messages (pk, chat_pk, account_pk, native_id, sent_at, text, normalized_text, normalizer_version,
                            ingested_at, ingested_via)
      SELECT i, 1, 1, CAST(i AS TEXT), i, 'квартиру ' || i, 'квартиру ' || i, 1, 0, 'history' FROM n`)
  })
  return path
}

describe("store version 15, the stems", () => {
  it("**stems a small file on open** from `messages.text`, claimed by the default analyzer", async () => {
    const path = await version14(3)
    await (await openStore({ path })).close()

    await withDatabase(path, (database) => {
      expect(stemsState(database)).toMatchObject({
        watermark: 3,
        filledThrough: 3,
        pending: 0,
        built: analyzerIdentity(DEFAULT_STEMMERS),
        ready: true,
      })
      expect(stemmed(database, "квартир")).toEqual([1, 2, 3])
    })
  })

  it("**leaves a larger file to the batches**, resumable after `until` stops them", async () => {
    const path = await version14(BACKFILL_ON_OPEN + 1)
    await (await openStore({ path })).close()

    await withDatabase(path, (database) => {
      expect(stemsState(database)).toMatchObject({ filledThrough: 0, built: null, ready: false, cause: "building" })
      let batches = 0
      fillStems(database, { batch: 2_000, until: () => batches++ >= 1 })
      expect(stemsState(database)).toMatchObject({ filledThrough: 2_000, ready: false })
      expect(fillStems(database, { batch: 2_000 }).stemmed).toBe(BACKFILL_ON_OPEN + 1 - 2_000)
      expect(stemsState(database)).toMatchObject({ filledThrough: BACKFILL_ON_OPEN + 1, ready: true })
      expect(stemsState(database)?.builtAt).toEqual(expect.any(String))
    })
  })

  it("**follows inserts, edits, tombstones and deletes** through the queue, emptied by each store write", async () => {
    const path = fresh()
    const store = await openStore({ path })
    await store.saveChats(ME, [chat])
    await store.saveMessages(ME, CHAT, [message("1", "квартиру"), message("2", "canciones")], { via: "history" })
    await store.saveMessages(ME, CHAT, [{ ...message("1", "домами"), editedAt: "2026-09-26T11:00:00.000Z" }], {
      via: "history",
    })
    await store.markDeleted(ME, ["2"], { chatId: CHAT })
    await store.close()

    await withDatabase(path, (database) => {
      expect(stemsState(database)).toMatchObject({ pending: 0, ready: true })
      expect(stemmed(database, "квартир")).toEqual([])
      expect(stemmed(database, "дом")).toEqual([1])
      expect(stemmed(database, "cancion")).toEqual([])
      database.exec("PRAGMA foreign_keys = OFF")
      database.exec("DELETE FROM messages WHERE pk = 1")
      expect(stemmed(database, "дом")).toEqual([])
      database.exec("INSERT INTO message_stems (message_stems, rank) VALUES ('integrity-check', 0)")
    })
  })

  describe("readiness", () => {
    it("**is not ready while the batches have not reached the watermark**", async () => {
      const path = await version14(BACKFILL_ON_OPEN + 1)
      await withDatabase(path, (database) => {
        migrate(database)
        expect(stemsState(database)).toMatchObject({ ready: false, cause: "building" })
      })
    })

    it("**is not ready while a message waits in the queue** — as an older binary leaves it", async () => {
      const path = await version14(2)
      await (await openStore({ path })).close()
      await withDatabase(path, (database) => {
        database.exec("UPDATE messages SET text = 'домами' WHERE pk = 1")
        expect(stemsState(database)).toMatchObject({ pending: 1, ready: false, cause: "building" })
        fillStems(database)
        expect(stemsState(database)).toMatchObject({ pending: 0, ready: true })
        expect(stemmed(database, "дом")).toEqual([1])
      })
    })

    it("**is not ready when the setting asks for other stemmers**, and only a reset rebuilds it", async () => {
      const path = await version14(2)
      await (await openStore({ path })).close()
      await withDatabase(path, (database) => {
        saveStoreStemmers(database, ENGLISH, 0)
        expect(stemsState(database)).toMatchObject({
          ready: false,
          cause: "stemmer_changed",
          built: analyzerIdentity(DEFAULT_STEMMERS),
          wanted: analyzerIdentity(ENGLISH),
        })
        database.exec("UPDATE messages SET text = 'домами' WHERE pk = 1")
        expect(fillStems(database)).toEqual({ stemmed: 0, drained: 0 })
        expect(stemsState(database)?.pending).toBe(1)

        expect(resetStems(database)).toBe(true)
        fillStems(database)
        expect(stemsState(database)).toMatchObject({ ready: true, built: analyzerIdentity(ENGLISH), pending: 0 })
        expect(stemmed(database, "дом")).toEqual([1])
      })
    })
  })

  it("**a store write leaves the queue alone when the stems were built by other choices**", async () => {
    const path = fresh()
    const store = await openStore({ path })
    await store.saveChats(ME, [chat])
    await store.saveMessages(ME, CHAT, [message("1", "квартиру")], { via: "history" })
    await store.saveStemmers(ENGLISH)
    await store.saveMessages(ME, CHAT, [message("2", "квартиру")], { via: "history" })
    expect(await store.stemsState()).toMatchObject({ pending: 1, cause: "stemmer_changed" })
    await store.close()
  })

  it("**an empty store is ready unclaimed**, so the first `config set` needs no reindex", async () => {
    const path = fresh()
    const store = await openStore({ path })
    expect(await store.stemsState()).toMatchObject({ ready: true, built: null })
    await store.saveStemmers(ENGLISH)
    expect(await store.stemsState()).toMatchObject({ ready: true, built: null })
    await store.saveChats(ME, [chat])
    await store.saveMessages(ME, CHAT, [message("1", "houses")], { via: "history" })
    expect(await store.stemsState()).toMatchObject({ ready: true, built: analyzerIdentity(ENGLISH), pending: 0 })
    await store.close()
  })

  it("**claiming the stems saves the default choices**, so an older default refuses instead of rebuilding", async () => {
    const store = await openStore({ path: fresh() })
    expect(await store.stemmers()).toBeUndefined()
    await store.saveChats(ME, [chat])
    await store.saveMessages(ME, CHAT, [message("1", "houses")], { via: "history" })
    expect(await store.stemmers()).toEqual(DEFAULT_STEMMERS)
    await store.close()
  })

  it("**a setting only a newer tool knows** leaves the store usable and the stems not ready", async () => {
    const path = await version14(1)
    await (await openStore({ path })).close()
    await withDatabase(path, (database) =>
      database.exec(
        `INSERT OR REPLACE INTO store_settings (key, value, at) VALUES ('searchStemmers', '{"cyrillic":"russian","latin":"portuguese"}', 0)`,
      ),
    )

    const store = await openStore({ path })
    await store.saveChats(ME, [chat])
    await store.saveMessages(ME, CHAT, [message("2", "casas")], { via: "history" })
    expect(await store.stemmers()).toBeNull()
    expect(await store.stemsState()).toMatchObject({ ready: false, cause: "stemmer_unknown", pending: 1 })
    expect(await store.fillStems()).toEqual({ stemmed: 0, drained: 0 })
    await store.close()
    await withDatabase(path, (database) => expect(() => resetStems(database)).toThrow(/upgrade this tool/))
  })

  describe("after the default changes", () => {
    const SPANISH = { cyrillic: "russian", latin: "spanish" } as const
    /** Stems built by a tool whose default was Spanish only, which saved no setting. */
    const builtByOldDefault = async (count: number): Promise<string> => {
      const path = await version14(count)
      await (await openStore({ path })).close()
      await withDatabase(path, (database) => {
        database.exec("DELETE FROM store_settings WHERE key = 'searchStemmers'")
        database
          .prepare("UPDATE search_index_state SET analyzer = ? WHERE name = 'message_stems'")
          .run(analyzerIdentity(SPANISH))
      })
      return path
    }

    it("**rebuilds stems an older default built** on open, with no reindex", async () => {
      const store = await openStore({ path: await builtByOldDefault(2) })
      expect(await store.stemsState()).toMatchObject({ ready: true, built: analyzerIdentity(DEFAULT_STEMMERS) })
      expect(await store.stemmers()).toEqual(DEFAULT_STEMMERS)
      await store.close()
    })

    it("**a larger file is building, not changed**, and fills like a first build", async () => {
      const path = await builtByOldDefault(BACKFILL_ON_OPEN + 1)
      const store = await openStore({ path })
      expect(await store.stemsState()).toMatchObject({ ready: false, cause: "building", filledThrough: 0 })
      await store.fillStems()
      expect(await store.stemsState()).toMatchObject({ ready: true, built: analyzerIdentity(DEFAULT_STEMMERS) })
      await store.close()
    })

    it("**leaves the owner's own choice** for `store reindex`", async () => {
      const path = await version14(2)
      await (await openStore({ path })).close()
      await withDatabase(path, (database) => saveStoreStemmers(database, SPANISH, 0))
      const store = await openStore({ path })
      expect(await store.stemsState()).toMatchObject({ ready: false, cause: "stemmer_changed" })
      await store.close()
    })
  })

  it("**refuses to rebuild stems a newer Snowball built**, asking to upgrade this tool", async () => {
    const path = await version14(1)
    await (await openStore({ path })).close()
    await withDatabase(path, (database) => {
      database.exec(
        "UPDATE search_index_state SET analyzer = 'snowball-9.0.0 cyrillic=russian latin=spanish' WHERE name = 'message_stems'",
      )
      expect(() => resetStems(database)).toThrow(/upgrade this tool/)
    })
  })
})
