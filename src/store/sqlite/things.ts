import { formatLocator } from "../../domain/locator.js"
import { formatReference, parseReference, type Reference } from "../../domain/references.js"
import type { CacheDatabase } from "../driver.js"

/** A row of the store as polymorphic columns name it: the singular table name and the row's id. */
export interface Thing {
  type: string
  id: number
}

export type ThingState = "available" | "deleted" | "unavailable"

/** Tables a simple reference names by id, and whether a row can be marked gone. */
const TABLES: Record<string, { table: string; tombstone: boolean }> = {
  note: { table: "notes", tombstone: true },
  document: { table: "documents", tombstone: true },
  person: { table: "persons", tombstone: false },
  organization: { table: "organizations", tombstone: true },
  project: { table: "projects", tombstone: true },
  task: { table: "tasks", tombstone: true },
  memory: { table: "memories", tombstone: false },
  decision: { table: "decisions", tombstone: true },
  bot: { table: "bots", tombstone: false },
  message: { table: "messages", tombstone: true },
  chat: { table: "chats", tombstone: false },
  identity: { table: "identities", tombstone: false },
  account: { table: "accounts", tombstone: false },
}

const storeId = (text: string) => (/^[1-9]\d{0,15}$/.test(text) ? Number(text) : undefined)

/**
 * The row a typed reference names, or `undefined` when the store holds none. An id from before store v2
 * (a ULID, an `entity:`) is simply not found: it is never guessed at.
 */
export const thingOf = (database: CacheDatabase, reference: Reference | string): Thing | undefined => {
  const parsed = typeof reference === "string" ? parseReference(reference) : reference
  const found = (type: string, row: Record<string, unknown> | undefined) =>
    row ? { type, id: Number(row.id) } : undefined
  switch (parsed.type) {
    case "message":
      return found(
        "message",
        database
          .prepare(
            "SELECT m.id FROM messages m JOIN chats c ON c.id = m.chat_id JOIN accounts a ON a.id = c.account_id " +
              "WHERE a.provider = ? AND a.external_id = ? AND c.external_id = ? AND m.external_id = ?",
          )
          .get(parsed.provider, parsed.account, parsed.chat, parsed.message),
      )
    case "chat":
      return found(
        "chat",
        database
          .prepare(
            "SELECT c.id FROM chats c JOIN accounts a ON a.id = c.account_id WHERE a.provider = ? AND a.external_id = ? AND c.external_id = ?",
          )
          .get(parsed.provider, parsed.account, parsed.chat),
      )
    case "contact":
      return found(
        "identity",
        database
          .prepare("SELECT id FROM identities WHERE provider = ? AND external_id = ?")
          .get(parsed.provider, parsed.id),
      )
    case "folder": {
      const id = storeId(parsed.id)
      return id === undefined
        ? undefined
        : found("account", database.prepare("SELECT id FROM accounts WHERE id = ? AND provider = 'folder'").get(id))
    }
    case "task": {
      const id = taskRowOf(database, parsed.id)
      return id === undefined ? undefined : { type: "task", id }
    }
    case "entity":
      return undefined
    default: {
      const id = storeId(parsed.id)
      const table = TABLES[parsed.type]?.table
      if (id === undefined || !table) return undefined
      return found(parsed.type, database.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id))
    }
  }
}

/** The reference people and agents read for a row; `undefined` once the row is gone. */
export const referenceOfThing = (database: CacheDatabase, thing: Thing): string | undefined => {
  switch (thing.type) {
    case "message": {
      const row = database
        .prepare(
          "SELECT a.provider, a.external_id AS account, c.external_id AS chat, m.external_id AS message FROM messages m " +
            "JOIN chats c ON c.id = m.chat_id JOIN accounts a ON a.id = c.account_id WHERE m.id = ?",
        )
        .get(thing.id)
      return row
        ? formatLocator({
            provider: String(row.provider),
            account: String(row.account),
            chat: String(row.chat),
            message: String(row.message),
          })
        : undefined
    }
    case "chat": {
      const row = database
        .prepare(
          "SELECT a.provider, a.external_id AS account, c.external_id AS chat FROM chats c JOIN accounts a ON a.id = c.account_id WHERE c.id = ?",
        )
        .get(thing.id)
      return row
        ? formatReference({
            type: "chat",
            provider: String(row.provider),
            account: String(row.account),
            chat: String(row.chat),
          })
        : undefined
    }
    case "identity": {
      const row = database.prepare("SELECT provider, external_id FROM identities WHERE id = ?").get(thing.id)
      return row
        ? formatReference({ type: "contact", provider: String(row.provider), id: String(row.external_id) })
        : undefined
    }
    case "account":
      return formatReference({ type: "folder", id: String(thing.id), path: null })
    case "task": {
      const id = taskIdOf(database, thing.id)
      return id === undefined ? undefined : `task:${id}`
    }
    default:
      return `${thing.type}:${thing.id}`
  }
}

export const stateOfThing = (database: CacheDatabase, thing: Thing | undefined): ThingState => {
  if (!thing) return "unavailable"
  const known = TABLES[thing.type]
  if (!known) return "unavailable"
  const row = database
    .prepare(`SELECT ${known.tombstone ? "deleted_at" : "NULL AS deleted_at"} FROM ${known.table} WHERE id = ?`)
    .get(thing.id)
  return !row ? "unavailable" : row.deleted_at == null ? "available" : "deleted"
}

/** The `tasks.id` behind what callers name a task by: the package's id, or the task's key. */
export const taskRowOf = (database: CacheDatabase, id: string): number | undefined => {
  const row = database
    .prepare("SELECT id FROM tasks WHERE json_extract(metadata, '$.id') = ? OR key = ? ORDER BY id LIMIT 1")
    .get(id, id)
  return row ? Number(row.id) : undefined
}

/** The package's id for a task row: the reverse of `taskRowOf`. */
export const taskIdOf = (database: CacheDatabase, rowId: number): string | undefined => {
  const row = database.prepare("SELECT key, json_extract(metadata, '$.id') AS id FROM tasks WHERE id = ?").get(rowId)
  return row ? String(row.id ?? row.key) : undefined
}
