// Phase 3 item 7, the store part: how long `replaceConversations` holds the write lock for one chat of
// N messages — other processes wait at most 5 s (`busy_timeout`). Same invented chat as scale.ts.
// Usage: pnpm build, then node --experimental-strip-types rebuild.ts <N> <scratch file>
import { createReadStream, rmSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"
import type { LinkInput } from "../../src/conversations/link.ts"
import { DATA_DIR, mulberry32 } from "../search/common.ts"

// The built package, as bench/search/store.ts: the sources import each other as .js.
const { openCache, openStore } = await import("../../dist/store/index.js")
const { linkMessages, RULES_VERSION } = await import("../../dist/conversations/link.js")

const [nArg, file] = process.argv.slice(2)
const n = Number(nArg)
if (!Number.isSafeInteger(n) || !file) throw new Error("usage: rebuild.ts <N> <scratch file>")
for (const suffix of ["", "-wal", "-shm"]) rmSync(`${file}${suffix}`, { force: true })

const ACCOUNT = { provider: "tg", account: "1" } as const
const setup = await openStore({ path: file })
await setup.saveChats(ACCOUNT, [
  { id: "-1", title: "Group", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
])
await setup.close()

const random = mulberry32(42)
const database = await openCache(file)
const insert = database.prepare(
  `INSERT INTO messages (account_pk, chat_pk, native_id, sender_chat_native_id, text, sent_at, reply_to_native_id,
     ingested_at, ingested_via) VALUES (1, 1, ?, ?, ?, ?, ?, 0, 'history')`,
)
const start = Date.parse("2026-01-01T00:00:00Z")
let index = 0
database.exec("BEGIN")
const lines = createInterface({ input: createReadStream(join(DATA_DIR, "corpus-1000000.tsv")) })
for await (const line of lines) {
  const [, , sender, , , text] = line.split("\t") as string[]
  const back = index === 0 ? null : index - 1 - Math.floor(random() * Math.min(index, 50))
  const reply = back !== null && random() < 0.6 ? String(back) : null
  insert.run(String(index), String(sender), String(text), start + index * 20_000, reply)
  if (++index === n) break
  if (index % 50_000 === 0) database.exec("COMMIT; BEGIN")
}
lines.close()
database.exec("COMMIT")
database.close()

const store = await openStore({ path: file })
const read = performance.now()
const inputs: LinkInput[] = []
let after: string | undefined
for (;;) {
  const page = await store.linkInputs(ACCOUNT, "-1", { limit: 5_000, ...(after === undefined ? {} : { after }) })
  inputs.push(...page.items)
  if (page.next === null) break
  after = page.next
}
const readMs = performance.now() - read
const rules = performance.now()
const { links, conversations } = linkMessages(inputs, { handles: await store.senderHandles(ACCOUNT, "-1") })
const rulesMs = performance.now() - rules

const timeWrite = async () => {
  const at = performance.now()
  await store.replaceConversations(ACCOUNT, "-1", { startedAt: Date.now(), algorithmVersion: RULES_VERSION, links, conversations })
  return performance.now() - at
}
const first = await timeWrite()
const again = await timeWrite()
await store.close()
const s = (ms: number) => `${(ms / 1000).toFixed(2)} s`
console.log(
  `| ${n.toLocaleString("en")} | ${s(readMs)} | ${s(rulesMs)} | ${s(first)} | ${s(again)} | ` +
    `${links.length.toLocaleString("en")} | ${conversations.length.toLocaleString("en")} | ` +
    `${Math.round(process.resourceUsage().maxRSS / 1024)} MB |`,
)
for (const suffix of ["", "-wal", "-shm"]) rmSync(`${file}${suffix}`, { force: true })
