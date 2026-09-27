import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll } from "vitest"

/** The shared store is the owner's system of record: a test that falls back to the default path would migrate it. */
const sandbox = mkdtempSync(join(tmpdir(), "cli-messaging-test-"))

process.env.MESSAGING_STORE = join(sandbox, "messages.db")
process.env.MESSAGING_STATE_DIR = join(sandbox, "state")
process.env.MESSAGING_CONFIG_DIR = join(sandbox, "config")
process.env.MESSAGING_CACHE_DIR = join(sandbox, "cache")
process.env.TMPDIR = sandbox

afterAll(() => rmSync(sandbox, { recursive: true, force: true }))
