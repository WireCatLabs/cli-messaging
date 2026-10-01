// Official Node before 22.16 ships SQLite without FTS5: the store must refuse with its own message and
// write nothing. Run on that Node, after `pnpm build`.
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const { openStore } = await import("../dist/store/store.js")
const path = join(mkdtempSync(join(tmpdir(), "old-node-")), "messages.db")
try {
  await openStore({ path })
  throw new Error(`the store opened on Node ${process.versions.node}`)
} catch (error) {
  if (!/the message store needs full-text search/.test(error.message)) throw error
}
if (existsSync(path)) throw new Error("the refused store still created its file")
console.log(`old node: Node ${process.versions.node} refused, nothing written`)
