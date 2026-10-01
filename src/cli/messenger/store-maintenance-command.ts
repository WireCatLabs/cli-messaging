import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, resolve } from "node:path"
import { CliError } from "@leemour/cli-core"
import { Command } from "commander"
import { holdersOf } from "../../background/processes.js"
import { RULES_VERSION } from "../../conversations/link.js"
import type { CacheDatabase } from "../../store/driver.js"
import { MIGRATIONS, migrate } from "../../store/migrations.js"
import { openCache } from "../../store/open.js"
import { storePath } from "../../store/path.js"
import { pendingNormalization } from "../../store/sqlite/backfill.js"
import { fillSearchIndex, resetSearchIndex, searchIndexState } from "../../store/sqlite/search-index.js"
import { environmentOf, outputFor } from "../context.js"
import type { Messenger } from "./context.js"
import { servingProfiles } from "./serve-command.js"

const SPEAKS = MIGRATIONS.at(-1)?.version ?? 0
const SEARCH_INDEXES = ["messages_fts", "chats_fts", "identities_fts"]
/** Contentless: it has no table to be compared with, only its own structure to check. */
const WORD_INDEX = "message_words"

/** An empty file is normal: `openStore` creates it before the first migration runs. */
const schemaOf = (database: CacheDatabase) => {
  const tracked = database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'schema_migrations'").get()
  const row = tracked
    ? database.prepare("SELECT version, min_compatible FROM schema_migrations ORDER BY version DESC LIMIT 1").get()
    : undefined
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
  reindexCommand(messenger),
  backupCommand(),
  restoreCommand(messenger),
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
      const read = reading(path, (database) => {
        const { version, minCompatible, writable } = schemaOf(database)
        const tables = ["accounts", "chats", "messages", "attachments", "identities"]
        return {
          path,
          exists: true,
          bytes: { file: bytesOf(path), wal: bytesOf(`${path}-wal`) },
          schema: { version, minCompatible, speaks: SPEAKS, writable },
          rows: version > 0 ? Object.fromEntries(tables.map((table) => [table, count(database, table)])) : {},
          pendingNormalization: pendingIfKnown(database),
          wordIndex: searchIndexState(database) ?? null,
        }
      })
      renderer.result(await read.catch((error) => ({ path, exists: true, opens: false, error: messageOf(error) })))
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
      let answer: Awaited<ReturnType<typeof inspect>>
      try {
        answer = await inspect(path)
      } catch (error) {
        renderer.result({ path, exists: true, ok: false, opens: false, error: messageOf(error) })
        return
      }
      renderer.result(answer)
      const { command } = messenger.app
      if (answer.schema.version < SPEAKS) {
        renderer.note(
          `the file is behind this build — a copy first, \`${command} store backup <file>\`, then \`${command} store migrate\``,
        )
      }
      if (answer.pendingNormalization) {
        renderer.note(`${answer.pendingNormalization} messages wait for normalization — \`${command} store migrate\``)
      }
      const words = answer.wordIndex
      if (words && words.filledThrough < words.watermark) {
        renderer.note(
          `the word index reaches message ${words.filledThrough} of ${words.watermark} — \`${command} store migrate\` finishes it`,
        )
      }
      const ours = answer.chatsBehind.filter((chat) => chat.provider === messenger.provider).length
      if (ours > 0)
        renderer.note(`${ours} chats hold less than their newest message — \`${command} store fetch <chat>\``)
      const older = answer.conversations.filter((chat) => chat.provider === messenger.provider && !chat.current).length
      if (older > 0) {
        renderer.note(
          `${older} chats' conversations were built by older rules — \`${command} conversations build --chat <chat>\``,
        )
      }
    })

const inspect = (path: string) =>
  reading(path, (database) => {
    const schema = schemaOf(database)
    const integrity = database
      .prepare("PRAGMA quick_check(20)")
      .all()
      .map((row) => String(row.quick_check))
    const foreignKeys = database.prepare("PRAGMA foreign_key_check").all().length
    const wordIndex = searchIndexState(database)
    const searchIndexes = Object.fromEntries([
      ...(schema.version > 0 ? SEARCH_INDEXES.map((index) => [index, indexIntegrity(database, index)]) : []),
      ...(wordIndex ? [[WORD_INDEX, indexIntegrity(database, WORD_INDEX, 0)]] : []),
    ])
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
      exists: true,
      opens: true,
      ok: Object.values(checks).every(Boolean),
      checks,
      schema: { ...schema, speaks: SPEAKS },
      integrity,
      foreignKeyViolations: foreignKeys,
      searchIndexes,
      disk: { free, needed: size },
      pendingNormalization: pendingIfKnown(database),
      wordIndex: wordIndex ?? null,
      chatsBehind: behind,
      conversations: conversationsBuilt(database),
      notApplicable: {
        extensions: "SQLite needs none",
        enrichment: "nothing is enriched yet, so there is no enrichment index to compare",
      },
    }
  })

/** `rank = 1` compares the index with its table; without it a stale external-content index passes. */
const indexIntegrity = (database: CacheDatabase, index: string, rank = 1): string => {
  try {
    database.prepare(`INSERT INTO ${index} (${index}, rank) VALUES ('integrity-check', ${rank})`).run()
    return "ok"
  } catch (error) {
    return messageOf(error)
  }
}

/**
 * Per chat whose conversations were built: by which rules, whether those are this build's, and how many
 * of the agent's links went stale — their message changed after they were written (phase 3 plan C4).
 */
const conversationsBuilt = (database: CacheDatabase) => {
  const exists = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversation_state'")
    .get()
  if (!exists) return []
  return database
    .prepare(
      `SELECT a.provider, a.native_id AS account, c.native_id AS chat, c.title, s.built_at, s.algorithm_version,
         (SELECT count(*) FROM message_links l WHERE l.chat_pk = c.pk AND l.source = 'agent' AND l.stale_at IS NOT NULL)
           AS stale
       FROM conversation_state s JOIN chats c ON c.pk = s.chat_pk JOIN accounts a ON a.pk = c.account_pk
       ORDER BY s.built_at DESC`,
    )
    .all()
    .map((row) => ({
      provider: String(row.provider),
      account: String(row.account),
      chat: String(row.chat),
      title: row.title === null ? null : String(row.title),
      builtAt: row.built_at === null ? null : isoOf(row.built_at),
      rulesVersion: row.algorithm_version === null ? null : Number(row.algorithm_version),
      current: Number(row.algorithm_version) === RULES_VERSION,
      staleAgentLinks: Number(row.stale),
    }))
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
        const { normalized, indexed, terms } = buildWordIndex(database, (note) => renderer.note(note))
        return { path, exists: true, from, to: schemaOf(database).version, normalized, indexed, terms }
      })
      renderer.result(answer)
    })

/** Normalizes, indexes and builds the typo vocabulary, saying how far each has gone. */
const buildWordIndex = (database: CacheDatabase, note: (text: string) => void) => {
  const state = searchIndexState(database)
  const pending = pendingNormalization(database)
  if (pending > 0) note(`normalizing ${pending} messages, in batches; stopping loses nothing`)
  if (state && state.filledThrough < state.watermark) note(`indexing words up to message ${state.watermark}`)
  return fillSearchIndex(database, {
    onBatch: (step, done) => note(step === "normalized" ? `${done} of ${pending} normalized` : `${done} ${step}`),
  })
}

const reindexCommand = (messenger: Messenger): Command =>
  new Command("reindex")
    .description("rebuild the word index and its typo vocabulary from the stored messages; loses no message")
    .action(async function (this: Command) {
      const { renderer } = outputFor(this)
      const path = storePath(environmentOf(this).env ?? process.env)
      if (!existsSync(path)) {
        renderer.result({ path, exists: false })
        return
      }
      const answer = await reading(path, (database) => {
        if (schemaOf(database).version < SPEAKS) {
          throw new CliError(
            "validation_error",
            `the store is behind this build — \`${messenger.app.command} store migrate\` first`,
          )
        }
        resetSearchIndex(database)
        return { path, exists: true, ...buildWordIndex(database, (note) => renderer.note(note)) }
      })
      renderer.result(answer)
    })

const backupCommand = (): Command =>
  new Command("backup")
    .description("copy the store into a new file, while it is in use; never overwrites a file")
    .argument("<file>", "the new file")
    .action(async function (this: Command, file: string) {
      const { renderer } = outputFor(this)
      const path = storePath(environmentOf(this).env ?? process.env)
      const target = resolve(file)
      if (!existsSync(path)) throw new CliError("not_found", `no store at ${path} to back up`)
      if (existsSync(target))
        throw new CliError("validation_error", `${target} exists — a backup never overwrites a file`)
      // VACUUM INTO fills an empty file and keeps its mode; a file it creates itself is readable by all.
      writeFileSync(target, "", { flag: "wx", mode: 0o600 })
      try {
        await reading(path, (database) => database.prepare("VACUUM INTO ?").run(target))
      } catch (error) {
        rmSync(target)
        throw error
      }
      const copy = await reading(target, (database) => ({
        schema: schemaOf(database).version,
        rows: { chats: count(database, "chats"), messages: count(database, "messages") },
      }))
      renderer.result({ path: target, from: path, bytes: bytesOf(target), ...copy })
    })

/**
 * Puts a backup in place of the store, keeping the store it replaces beside it. Refuses while any
 * process has the file open — it would go on writing to the file set aside — or while this CLI's
 * `serve` runs: that opens the store on its first write, so until then it holds nothing to see.
 */
const restoreCommand = (messenger: Messenger): Command =>
  new Command("restore")
    .description("put a backup in place of the store; the store it replaces is kept beside it, never deleted")
    .argument("<file>", "a file `store backup` wrote")
    .action(async function (this: Command, file: string) {
      const { renderer } = outputFor(this)
      const path = storePath(environmentOf(this).env ?? process.env)
      const backup = resolve(file)
      if (!existsSync(backup)) throw new CliError("not_found", `no file at ${backup}`)
      if (existsSync(path) && realpathSync(backup) === realpathSync(path)) {
        throw new CliError("validation_error", `${backup} is the store itself`)
      }
      const schema = await backupSchema(backup)

      const env = environmentOf(this).env ?? process.env
      const serving = servingProfiles(messenger.app, env)
      if (serving.length > 0) {
        throw new CliError(
          "validation_error",
          `${messenger.app.command} serve is running for ${serving.join(", ")} — \`${messenger.app.command} server stop\` first`,
        )
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, "-")
      const kept = existsSync(path) ? `${path}.before-restore-${stamp}` : null
      if (kept) await quiesce(path, messenger, (message) => renderer.warn(message))
      else mkdirSync(dirname(path), { recursive: true, mode: 0o700 })

      const incoming = `${path}.restoring-${stamp}`
      copyFileSync(backup, incoming, constants.COPYFILE_EXCL)
      chmodSync(incoming, 0o600)
      if (kept) {
        renameSync(path, kept)
        for (const suffix of ["-wal", "-shm"])
          if (existsSync(`${path}${suffix}`)) renameSync(`${path}${suffix}`, `${kept}${suffix}`)
      }
      renameSync(incoming, path)

      renderer.result({ path, restoredFrom: backup, keptAt: kept, schema: schema.version })
      if (kept) renderer.note(`the store it replaced is kept at ${kept}`)
      // One that has not touched the store yet holds nothing open, and was not seen.
      renderer.note("restart every serve and mcp of either CLI that was running, so they read the restored store")
      if (schema.version < SPEAKS) {
        renderer.note(
          `the backup is behind this build; the next command migrates it — \`${messenger.app.command} store migrate\` now`,
        )
      }
    })

const backupSchema = async (backup: string) => {
  let read: { integrity: string; schema: ReturnType<typeof schemaOf> }
  try {
    read = await reading(backup, (database) => ({
      integrity: String(database.prepare("PRAGMA quick_check(1)").get()?.quick_check),
      schema: schemaOf(database),
    }))
  } catch (error) {
    throw new CliError("validation_error", `${backup} is not a store this tool can read: ${messageOf(error)}`)
  }
  const { integrity, schema } = read
  if (schema.version === 0) throw new CliError("validation_error", `${backup} holds no message store`)
  if (integrity !== "ok") throw new CliError("validation_error", `${backup} is damaged: ${integrity}`)
  if (!schema.writable) {
    throw new CliError(
      "configuration_error",
      `the backup was written by a newer version (schema ${schema.version}, needs at least ` +
        `${schema.minCompatible}; this one speaks ${SPEAKS}) — upgrade this tool`,
    )
  }
  return schema
}

/**
 * No other process has the file open, no write is under way, and the write-ahead log is folded in,
 * so the file set aside is whole on its own. In WAL mode SQLite cannot say who has the file open —
 * `EXCLUSIVE` behaves as `IMMEDIATE` — so that is asked of the system.
 */
const quiesce = async (path: string, messenger: Messenger, warn: (message: string) => void) => {
  const { command } = messenger.app
  const files = [path, `${path}-wal`, `${path}-shm`]
    .filter((file) => existsSync(file))
    .map((file) => realpathSync(file))
  const holders = holdersOf(files)
  if (holders === undefined) {
    warn(`this system cannot say which processes have the store open — restart every running serve and mcp after this`)
  } else if (holders.length > 0) {
    throw new CliError(
      "validation_error",
      `the store is open in process ${holders.join(", ")} — stop it first (a serve: \`${command} server stop\`, ` +
        "or the other CLI's; an mcp: its client), then restore",
    )
  }
  const database = await openCache(path)
  try {
    database.exec("PRAGMA busy_timeout = 1000")
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    try {
      database.exec("BEGIN IMMEDIATE")
    } catch {
      throw new CliError("validation_error", "a write to the store is under way — try again in a moment")
    }
    database.exec("ROLLBACK")
  } finally {
    database.close()
  }
}

const isoOf = (value: unknown) => new Date(Number(value)).toISOString()

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
