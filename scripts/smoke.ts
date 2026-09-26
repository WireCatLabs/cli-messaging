/**
 * The second runtime, actually executed: Bun cannot run the Vitest suite, and the SQLite seam picks
 * a different module under each runtime, so a type check proves nothing about it.
 *
 *   bun run scripts/smoke.ts
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { settingsFor } from "../src/cli/index.js"
import { formatLocator, parseLocator, renderMessages } from "../src/index.js"
import { openCache } from "../src/store/index.js"

const runtime = typeof (globalThis as { Bun?: unknown }).Bun === "undefined" ? "node" : "bun"
const failures: string[] = []
const check = (what: string, condition: boolean) => {
  if (!condition) failures.push(what)
}

const database = await openCache(join(mkdtempSync(join(tmpdir(), "cli-messaging-smoke-")), "smoke.db"))
database.exec("CREATE VIRTUAL TABLE t USING fts5(text, tokenize='trigram')")
database.prepare("INSERT INTO t (text) VALUES (?)").run("Иван Петров")
check(
  "the SQLite seam opens a database in WAL mode",
  database.prepare("PRAGMA journal_mode").get()?.journal_mode === "wal",
)
check(
  "FTS5 with trigram finds inside a Cyrillic word",
  database.prepare("SELECT * FROM t WHERE t MATCH ?").all("етро").length === 1,
)
database.close()

const locator = { provider: "telegram", account: "1", chat: "-1002", message: "3" }
check("a locator round-trips", JSON.stringify(parseLocator(formatLocator(locator))) === JSON.stringify(locator))
check("an empty feed renders", renderMessages([]) === "(nothing)")

const app = { command: "app", appName: "app-cli", envPrefix: "APP", description: "", version: "0" }
const settings = settingsFor(app).resolveSettings(
  { timeout: "2s" },
  { env: {}, configDir: mkdtempSync(join(tmpdir(), "cli-messaging-smoke-")) },
)
check("settings resolve with no file", settings.profile === "default" && settings.commandTimeoutMs === 2000)

if (failures.length > 0) {
  console.error(`smoke failed under ${runtime}:\n${failures.map((one) => `  - ${one}`).join("\n")}`)
  process.exit(1)
}
console.log(`smoke passed under ${runtime}`)
