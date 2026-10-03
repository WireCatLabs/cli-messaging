import { fork } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { openCache } from "./open.js"
import { openSqlite } from "./sqlite/open.js"

const openers = {
  cache: openCache,
  store: async (path: string) => (await openSqlite(path)).database,
}

describe.each(Object.entries(openers))("%s connection contention", (_, open) => {
  it("waits for a short lock before initializing journal mode", async () => {
    ;(await open(":memory:")).close()
    const directory = mkdtempSync(join(tmpdir(), "store-open-contention-"))
    const path = join(directory, "messages.db")
    const script = join(directory, "holder.mjs")
    writeFileSync(
      script,
      `import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[2]);
db.exec("CREATE TABLE held (value INTEGER); BEGIN EXCLUSIVE; INSERT INTO held VALUES (1)");
process.send("locked");
process.on("message", () => setTimeout(() => {
  db.exec("COMMIT"); db.close(); process.disconnect();
}, 25));`,
    )
    const holder = fork(script, [path], { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] })
    const done = new Promise<void>((resolve, reject) => {
      holder.once("error", reject)
      holder.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`lock holder exited ${code}`))))
    })
    await new Promise<void>((resolve, reject) => {
      holder.once("message", () => resolve())
      holder.once("error", reject)
    })
    holder.send("release")
    try {
      const database = await open(path)
      try {
        expect(database.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" })
        expect(database.prepare("SELECT value FROM held").get()).toEqual({ value: 1 })
      } finally {
        database.close()
      }
    } finally {
      await done
    }
  })
})
