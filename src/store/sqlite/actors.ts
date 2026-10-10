import { CliError } from "@wirecat/cli-core"
import type { CacheDatabase } from "../driver.js"

/** Who made or owns something: the store's polymorphic actor pair. */
export interface Actor {
  type: "person" | "bot"
  id: number
}

/** How the task package names who acted; each maps to one stable actor row. */
export type Origin = "owner" | "agent" | "rule"

const BOT_KINDS = ["agent", "script", "integration"] as const

/** The owner's person row, made on first need: a fresh store has none until a messenger saves people. */
export const ownerPerson = (database: CacheDatabase, now: number): Actor => {
  const found = database.prepare("SELECT id FROM persons WHERE owner = 1 ORDER BY id LIMIT 1").get()
  if (found) return { type: "person", id: Number(found.id) }
  const made = database
    .prepare("INSERT INTO persons (name, owner, created_at, updated_at) VALUES (NULL, 1, ?, ?) RETURNING id")
    .get(now, now)
  return { type: "person", id: Number(made?.id) }
}

/** A bot by its unique handle, registered on first use. */
export const botNamed = (
  database: CacheDatabase,
  name: string,
  now: number,
  kind: (typeof BOT_KINDS)[number] = "agent",
): Actor => {
  const handle = name.trim()
  if (!handle || handle.length > 100) throw new CliError("validation_error", "a bot's name takes 1–100 characters")
  if (!BOT_KINDS.includes(kind))
    throw new CliError("validation_error", `a bot's kind is one of ${BOT_KINDS.join(", ")}`)
  database
    .prepare("INSERT INTO bots (name, kind, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (name) DO NOTHING")
    .run(handle, kind, now, now)
  return { type: "bot", id: Number(database.prepare("SELECT id FROM bots WHERE name = ?").get(handle)?.id) }
}

/**
 * The task package's origins as actors: the owner is the owner's person, a rule and an unnamed agent are
 * the bots `rule` and `agent`.
 */
export const actorOfOrigin = (database: CacheDatabase, origin: Origin, now: number): Actor =>
  origin === "owner"
    ? ownerPerson(database, now)
    : botNamed(database, origin, now, origin === "rule" ? "script" : "agent")

export const originOfActor = (database: CacheDatabase, type: unknown, id: unknown): Origin | undefined => {
  if (type == null || id == null) return undefined
  if (type === "person") return "owner"
  return database.prepare("SELECT name FROM bots WHERE id = ?").get(Number(id))?.name === "rule" ? "rule" : "agent"
}
