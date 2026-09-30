/**
 * The built package opens the store through bundled Drizzle, never through `node_modules`, where
 * `drizzle-orm` is only a development dependency. Run after `pnpm build`.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const dist = join(import.meta.dirname, "../dist/store/sqlite")
const leaks = readdirSync(join(dist, "drizzle"))
  .filter((name) => name.endsWith(".js"))
  .filter((name) =>
    /from\s*"drizzle-orm|import\(\s*"drizzle-orm/.test(readFileSync(join(dist, "drizzle", name), "utf8")),
  )
if (leaks.length > 0) throw new Error(`the bundle still imports drizzle-orm: ${leaks.join(", ")}`)

const { openSqlite } = await import(join(dist, "open.js"))
const { migrate } = await import(join(dist, "../migrations.js"))
const { accounts } = await import(join(dist, "schema.js"))
const store = await openSqlite(":memory:")
migrate(store.database)
store.database.prepare("INSERT INTO accounts (provider, native_id, created_at) VALUES ('telegram', '1', 0)").run()
const rows = await store.orm.select().from(accounts)
store.database.close()
if (rows.length !== 1) throw new Error(`bundled Drizzle read ${rows.length} rows, not 1`)
console.log("dist: Drizzle bundled and working")
