import { existsSync, statfsSync, statSync } from "node:fs"
import { dirname } from "node:path"
import { Command } from "commander"
import type { CacheDatabase } from "../../store/driver.js"
import { MIGRATIONS, migrate } from "../../store/migrations.js"
import { openCache } from "../../store/open.js"
import { storePath } from "../../store/path.js"
import { backfillNormalized, pendingNormalization } from "../../store/sqlite/backfill.js"
import { environmentOf, outputFor } from "../context.js"
import type { Messenger } from "./context.js"

const SPEAKS = MIGRATIONS.at(-1)?.version ?? 0
const SEARCH_INDEXES = ["messages_fts", "chats_fts", "identities_fts"]

const schemaOf = (database: CacheDatabase) => {
  const row = database
    .prepare("SELECT version, min_compatible FROM schema_migrations ORDER BY version DESC LIMIT 1")
    .get()
  const version = Number(row?.version ?? 0)
  const minCompatible = Number(row?.min_compatible ?? 0)
  return { version, minCompatible, writable: version <= SPEAKS || minCompatible <= SPEAKS }
}

const count = (database: CacheDatabase, table: string) =>
  Number(database.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? 0)

/** Before version 6 the column does not exist, and a file behind this build is not migrated here. */
const pendingIfKnown = (database: CacheDatabase): number | null =>
  database.prepare("SELECT 1 FROM pragma_table_info('messages') WHERE name = 'normalized_text'").get()
    ? pendingNormalization(database)
    : null

const bytesOf = (path: string) => (existsSync(path) ? statSync(path).size : 0)

/** Opens the file as it is. Migrating here would change what the caller asked to look at. */
const reading = async <T>(path: string, read: (database: CacheDatabase) => T): Promise<T> => {
  const database = await openCache(path)
  try {
    return read(database)
  } finally {
    database.close()
  }
}

/** `doctor`'s short summary of the store. Must answer for a broken file, so an error is a field. */
export const storeSummary = async (env: NodeJS.ProcessEnv) => {
  const path = storePath(env)
  if (!existsSync(path)) return { path, exists: false }
  try {
    return await reading(path, (database) => {
      const { version, writable } = schemaOf(database)
      return {
        path,
        exists: true,
        schema: version,
        speaks: SPEAKS,
        writable,
        ...(version > 0 ? { chats: count(database, "chats"), messages: count(database, "messages") } : {}),
      }
    })
  } catch (error) {
    return { path, exists: true, error: messageOf(error) }
  }
}

export const storeMaintenanceCommands = (messenger: Messenger): Command[] => [
  infoCommand(),
  checkCommand(messenger),
  migrateCommand(messenger),
]

const infoCommand = (): Command =>
  new Command("info")
    .description("the store file: where it is, its size, its schema and how many rows it holds; changes nothing")
    .action(async function (this: Command) {
      const { renderer } = outputFor(this)
      const path = storePath(environmentOf(this).env ?? process.env)
      if (!existsSync(path)) {
        renderer.result({ path, exists: false })
        return
      }
      const answer = await reading(path, (database) => {
        const { version, minCompatible, writable } = schemaOf(database)
        const tables = ["accounts", "chats", "messages", "attachments", "identities"]
        return {
          path,
          exists: true,
          bytes: { file: bytesOf(path), wal: bytesOf(`${path}-wal`) },
          schema: { version, minCompatible, speaks: SPEAKS, writable },
          rows: version > 0 ? Object.fromEntries(tables.map((table) => [table, count(database, table)])) : {},
          pendingNormalization: pendingIfKnown(database),
        }
      })
      renderer.result(answer)
    })

/**
 * Reports and never repairs. The per-chat completeness is what tells "nothing was said" from "not
 * fetched" (NEED-399 A). Times are the chat's newest message by the messenger's list against the
 * newest message held, not `sync_ranges`: those are in message ids, which a chat list does not give.
 */
const checkCommand = (messenger: Messenger): Command =>
  new Command("check")
    .description("whether the store is healthy — integrity, search indexes, disk, and which chats are behind")
    .action(async function (this: Command) {
      const { renderer } = outputFor(this)
      const path = storePath(environmentOf(this).env ?? process.env)
      if (!existsSync(path)) {
        renderer.result({ path, exists: false, ok: true })
        return
      }
      const answer = await reading(path, (database) => {
        const schema = schemaOf(database)
        const integrity = database
          .prepare("PRAGMA quick_check(20)")
          .all()
          .map((row) => String(row.quick_check))
        const foreignKeys = database.prepare("PRAGMA foreign_key_check").all().length
        const searchIndexes = Object.fromEntries(
          SEARCH_INDEXES.map((index) => [index, indexIntegrity(database, index)]),
        )
        const size = bytesOf(path) + bytesOf(`${path}-wal`)
        const { bavail, bsize } = statfsSync(dirname(path))
        const free = Number(bavail) * Number(bsize)
        const behind = schema.version > 0 ? chatsBehind(database) : []
        const checks = {
          schema: schema.version === SPEAKS,
          integrity: integrity.length === 1 && integrity[0] === "ok",
          foreignKeys: foreignKeys === 0,
          searchIndexes: Object.values(searchIndexes).every((state) => state === "ok"),
          // A backup or a VACUUM needs about as much again.
          disk: free >= size,
        }
        return {
          path,
          ok: Object.values(checks).every(Boolean),
          checks,
          schema: { ...schema, speaks: SPEAKS },
          integrity,
          foreignKeyViolations: foreignKeys,
          searchIndexes,
          disk: { free, needed: size },
          pendingNormalization: pendingIfKnown(database),
          chatsBehind: behind,
          notApplicable: {
            extensions: "SQLite needs none",
            enrichment: "nothing is enriched yet, so there is no enrichment index to compare",
          },
        }
      })
      renderer.result(answer)
      const command = messenger.app.command
      if (answer.schema.version < SPEAKS) renderer.note(`the file is behind this build — \`${command} store migrate\``)
      if (answer.pendingNormalization) {
        renderer.note(`${answer.pendingNormalization} messages wait for normalization — \`${command} store migrate\``)
      }
      if (answer.chatsBehind.length > 0) {
        renderer.note(
          `${answer.chatsBehind.length} chats hold less than their newest message — \`${command} store fetch <chat>\``,
        )
      }
    })

/** `rank = 1` compares the index with its table; without it a stale external-content index passes. */
const indexIntegrity = (database: CacheDatabase, index: string): string => {
  try {
    database.prepare(`INSERT INTO ${index} (${index}, rank) VALUES ('integrity-check', 1)`).run()
    return "ok"
  } catch (error) {
    return messageOf(error)
  }
}

const chatsBehind = (database: CacheDatabase) =>
  database
    .prepare(
      `SELECT a.provider, a.native_id AS account, c.native_id AS chat, c.title, c.last_message_at AS newest,
         (SELECT max(m.sent_at) FROM messages m WHERE m.chat_pk = c.pk) AS held, c.updated_at AS refreshed
       FROM chats c JOIN accounts a ON a.pk = c.account_pk
       WHERE c.last_message_at IS NOT NULL
       ORDER BY c.last_message_at DESC`,
    )
    .all()
    .filter((row) => row.held === null || Number(row.held) < Number(row.newest))
    .map((row) => ({
      provider: String(row.provider),
      account: String(row.account),
      chat: String(row.chat),
      title: row.title === null ? null : String(row.title),
      newest: isoOf(row.newest),
      held: row.held === null ? null : isoOf(row.held),
      refreshed: isoOf(row.refreshed),
    }))

const migrateCommand = (messenger: Messenger): Command =>
  new Command("migrate")
    .description("bring the store up to this build's schema, then normalize the messages stored before it")
    .action(async function (this: Command) {
      const { renderer } = outputFor(this)
      const path = storePath(environmentOf(this).env ?? process.env)
      if (!existsSync(path)) {
        renderer.result({ path, exists: false })
        renderer.note(`no store yet — the first \`${messenger.app.command}\` command that reads a chat creates it`)
        return
      }
      const answer = await reading(path, (database) => {
        const from = schemaOf(database).version
        migrate(database)
        const pending = pendingNormalization(database)
        if (pending > 0) renderer.note(`normalizing ${pending} messages, in batches; stopping loses nothing`)
        const normalized = backfillNormalized(database, {
          onBatch: (filled) => renderer.note(`${filled} of ${pending}`),
        })
        return { path, exists: true, from, to: schemaOf(database).version, normalized }
      })
      renderer.result(answer)
    })

const isoOf = (value: unknown) => new Date(Number(value)).toISOString()

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
