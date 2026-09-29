import { mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { afterEach, describe, expect, it } from "vitest"
import type { CacheDatabase } from "../driver.js"
import { migrate } from "../migrations.js"
import { openCache } from "../open.js"
import { type OpenedSqlite, openSqlite } from "./open.js"
import { accounts } from "./schema.js"

const fresh = () => join(mkdtempSync(join(tmpdir(), "schema-")), "messages.db")
const opened: CacheDatabase[] = []
afterEach(() => {
  for (const database of opened.splice(0)) database.close()
})

const open = async (): Promise<CacheDatabase> => {
  const database = await openCache(fresh())
  opened.push(database)
  return database
}

const baselineStatements = (): string[] => {
  const root = join(import.meta.dirname, "../../../drizzle")
  const folder = readdirSync(root).find((name) => name.endsWith("_baseline"))
  if (!folder) throw new Error("no baseline migration under drizzle/")
  return readFileSync(join(root, folder, "migration.sql"), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean)
}

/** Tables, columns, keys and indexes as SQLite reports them — the FTS tables and their shadows left out. */
const shape = (database: CacheDatabase) => {
  const rows = (sql: string) => database.prepare(sql).all()
  const tables = rows(
    `SELECT name FROM sqlite_schema WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' AND name != 'schema_migrations'
     ORDER BY name`,
  ).map((row) => String(row.name))
  return Object.fromEntries(
    tables.map((table) => [
      table,
      {
        columns: rows(
          `SELECT name, upper(type) AS type, "notnull", dflt_value, pk FROM pragma_table_xinfo('${table}')`,
        ),
        foreignKeys: rows(`SELECT "table", "from", "to" FROM pragma_foreign_key_list('${table}') ORDER BY "from"`),
        indexes: rows(`SELECT name, "unique", origin, partial FROM pragma_index_list('${table}') ORDER BY name`).map(
          (index) => ({
            ...index,
            columns: rows(
              `SELECT name, "desc", coll FROM pragma_index_xinfo('${String(index.name)}') WHERE key = 1 ORDER BY seqno`,
            ),
          }),
        ),
      },
    ]),
  )
}

describe("the Drizzle schema", () => {
  it("**builds the same tables, columns, keys and indexes as migrations 1–5**", async () => {
    const migrated = await open()
    migrate(migrated)
    const baseline = await open()
    for (const statement of baselineStatements()) baseline.exec(statement)

    expect(shape(baseline)).toEqual(shape(migrated))
  })

  it("reads through Drizzle what the hand-written SQL wrote, over one connection", async () => {
    const store: OpenedSqlite = await openSqlite(fresh())
    migrate(store.database)
    store.database
      .prepare("INSERT INTO accounts (provider, native_id, name, created_at) VALUES (?, ?, ?, ?)")
      .run("telegram", "100", "Ana", 1)

    expect(await store.orm.select().from(accounts).where(eq(accounts.nativeId, "100"))).toEqual([
      { pk: 1, provider: "telegram", nativeId: "100", name: "Ana", createdAt: 1 },
    ])
    store.database.close()
  })
})
