// Phase 3 item 7: how long the rules take, and how much memory, for one chat of N messages. Reads the
// first N rows of bench/search's corpus as one chat and invents its replies and mentions.
// Usage: node --experimental-strip-types scale.ts <N>   (one N per process, so peak memory is that N's)
import { createReadStream } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { type LinkInput, linkMessages } from "../../src/conversations/link.ts"
import { DATA_DIR, mulberry32 } from "../search/common.ts"

const n = Number(process.argv[2])
if (!Number.isSafeInteger(n) || n <= 0) throw new Error("usage: scale.ts <N>")

// Shares as measured in a large public group (phase 3 plan §3): 60% of messages in a reply link, 97%
// of parents within 50 messages back.
const REPLY_SHARE = 0.6
const MENTION_SHARE = 0.05
const random = mulberry32(42)
const pick = (below: number) => Math.floor(random() * below)

const messages: LinkInput[] = []
const handles = new Map<string, string>()
const start = Date.parse("2026-01-01T00:00:00Z")
const lines = createInterface({ input: createReadStream(join(DATA_DIR, "corpus-1000000.tsv")) })
for await (const line of lines) {
  const [id, , sender, , , text] = line.split("\t") as string[]
  const index = messages.length
  const back = index === 0 ? undefined : messages[index - 1 - pick(Math.min(index, 50))]
  const mentioned = back && random() < MENTION_SHARE ? `@u${back.senderId} ` : ""
  if (mentioned) handles.set(`u${back?.senderId}`, String(back?.senderId))
  messages.push({
    id: String(id),
    senderId: String(sender),
    text: `${mentioned}${text}`,
    timestamp: new Date(start + index * 20_000).toISOString(),
    ...(back && random() < REPLY_SHARE ? { replyToId: back.id } : {}),
  })
  if (messages.length === n) break
}
lines.close()
if (messages.length < n) throw new Error(`the corpus has ${messages.length} rows; generate it with bench/search/gen.ts`)

const before = process.memoryUsage().heapUsed
const started = performance.now()
const { links, conversations } = linkMessages(messages, { handles })
const seconds = (performance.now() - started) / 1000
const heap = (process.memoryUsage().heapUsed - before) / 2 ** 20

console.log(
  `| ${n.toLocaleString("en")} | ${seconds.toFixed(2)} s | ${Math.round(n / seconds).toLocaleString("en")} msg/s | ` +
    `${links.length.toLocaleString("en")} | ${conversations.length.toLocaleString("en")} | ` +
    `${Math.round(heap)} MB | ${Math.round(process.resourceUsage().maxRSS / 1024)} MB |`,
)
