/**
 * The second runtime, actually executed: Bun cannot run the Vitest suite, and the SQLite seam picks
 * a different module under each runtime, so a type check proves nothing about it.
 *
 *   bun run scripts/smoke.ts
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { listRuns, readEvents, recorded, settingsFor } from "../src/cli/index.js"
import { formatLocator, parseLocator, renderMessages } from "../src/index.js"
import { openCache, openStore } from "../src/store/index.js"
import { normalize } from "../src/store/normalize.js"

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

const runsDir = join(mkdtempSync(join(tmpdir(), "cli-messaging-smoke-")), "runs")
const recording = { app, command: "chats list", profile: "default", keepFailed: false, trace: false } as const
await recorded({ ...recording, record: true, format: "json", runsDir }, async (events) => {
  events({ event: "request", operation: "chats.list" })
})
const [kept] = listRuns(runsDir)
check("a recorded run finishes", kept?.status === "success")
check(
  "its log is flushed on finish",
  readEvents(join(runsDir, kept?.startedAt.slice(0, 10) ?? "", kept?.runId ?? "")).length === 1,
)

const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "cli-messaging-smoke-")), "messages.db") })
const account = { provider: "telegram", account: "1" }
const stored = {
  id: "3",
  chatId: "-1002",
  senderId: "7",
  senderName: "Иван",
  timestamp: "2026-09-27T10:00:00.000Z",
  editedAt: null,
  text: "Иван Петров пишет",
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
}
await store.saveMessages(account, "-1002", [stored], { via: "smoke" })
check(
  "the store gives a message back",
  (await store.messages(account, "-1002", { limit: 5 })).items[0]?.text === stored.text,
)
check("the store finds a Cyrillic word by its beginning", (await store.search("Петр", { limit: 5 })).items.length === 1)
await store.close()
check(
  "the normalizer folds accents, ё and й as under Node",
  normalize("Ёжик ﬁnds\tЙогурт в València") === "ежик finds иогурт в valencia",
)

if (failures.length > 0) {
  console.error(`smoke failed under ${runtime}:\n${failures.map((one) => `  - ${one}`).join("\n")}`)
  process.exit(1)
}
console.log(`smoke passed under ${runtime}`)
