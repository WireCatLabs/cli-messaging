import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll } from "vitest"
// Every `openStore` loads Drizzle, about 200 ms from `node_modules`: loaded here, it is not charged to a test's timeout.
import "../store/sqlite/drizzle/node.js"

/** The shared store is the owner's system of record: a test that falls back to the default path would migrate it. */
const sandbox = mkdtempSync(join(tmpdir(), "cli-messaging-test-"))

process.env.MESSAGING_STORE = join(sandbox, "messages.db")
process.env.MESSAGING_STATE_DIR = join(sandbox, "state")
process.env.MESSAGING_CONFIG_DIR = join(sandbox, "config")
process.env.CLI_COMMON_CACHE_DIR = join(sandbox, "cache")
// The apps the tests define: a failure is kept as a run, and a test without its own directories would keep it at home.
for (const prefix of ["APP", "CHAT", "TG"]) {
  process.env[`${prefix}_STATE_DIR`] = join(sandbox, prefix, "state")
  process.env[`${prefix}_CONFIG_DIR`] = join(sandbox, prefix, "config")
  process.env[`${prefix}_CACHE_DIR`] = join(sandbox, prefix, "cache")
  process.env[`${prefix}_CACHE_DIR`] = join(sandbox, prefix, "cache")
}
process.env.TMPDIR = sandbox

afterAll(() => rmSync(sandbox, { recursive: true, force: true }))
