import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import type { Message } from "../../dist/domain/models.js"
import { searchCombined, type CombinedOptions } from "../../dist/services/messages-combined.js"
import { searchStore } from "../../dist/services/messages.js"
import { openStore } from "../../dist/store/store.js"

type Query = { id: string; split: "dev" | "test"; category: string; lucene: string; relevant: Record<string, number> }
type Corpus = {
  chats: { id: string; title: string }[]
  messages: Pick<Message, "id" | "chatId" | "senderId" | "timestamp" | "text">[]
  queries: Query[]
}
type Row = {
  id: string
  category: string
  recallAt10: number | null
  mrr: number | null
  ndcgAt10: number | null
  falseHits: number
  ids: string[]
  elapsedMs: number
}
const bytes = readFileSync(new URL("./corpus.json", import.meta.url))
const corpus = JSON.parse(bytes.toString()) as Corpus
const root = mkdtempSync(join(tmpdir(), "combined-quality-"))
process.env.TZ = "UTC"
process.env.MESSAGING_STORE = join(root, "quality.db")
process.env.CLI_COMMON_CACHE_DIR = join(root, "empty-cache")
const store = await openStore({ path: process.env.MESSAGING_STORE })
const account = { provider: "synthetic", account: "500" }
const report = (rows: Row[]) => {
  const answerable = rows.filter((r) => r.recallAt10 !== null)
  const average = (key: "recallAt10" | "mrr" | "ndcgAt10") =>
    answerable.reduce((s, r) => s + (r[key] ?? 0), 0) / answerable.length
  const times = rows.map((r) => r.elapsedMs).sort((a, b) => a - b)
  return {
    recallAt10: average("recallAt10"),
    mrr: average("mrr"),
    ndcgAt10: average("ndcgAt10"),
    noAnswerFalseHits: rows.reduce((s, r) => s + r.falseHits, 0),
    p50Ms: times[Math.floor(times.length * 0.5)],
    p95Ms: times[Math.floor(times.length * 0.95)],
  }
}
const configurations: CombinedOptions[] = []
for (const candidateDepth of [50, 100, 300, 500])
  for (const rrfK of [20, 60, 100])
    for (const rerank of ["none", "coverage", "proximity", "phrase", "all"] as const)
      for (const chatCap of [0, 3, 5]) configurations.push({ candidateDepth, rrfK, rerank, chatCap })
try {
  await store.saveChats(
    account,
    corpus.chats.map((c) => ({ ...c, kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 100 })),
  )
  for (const chat of corpus.chats)
    await store.saveMessages(
      account,
      chat.id,
      corpus.messages
        .filter((m) => m.chatId === chat.id)
        .map(
          (m): Message => ({
            ...m,
            senderName: `Synthetic ${m.senderId}`,
            editedAt: null,
            outgoing: false,
            attachments: [],
            replyTo: null,
            forwardedFrom: null,
            reactions: null,
          }),
        ),
      { via: "synthetic" },
    )
  await store.fillSearchIndex({})
  await store.fillStems({})
  const run = async (options: CombinedOptions, queries: Query[]) => {
    const rows: Row[] = []
    for (const q of queries) {
      const start = performance.now()
      const found = await searchCombined(store, account, { text: q.lucene, limit: 10, timezone: "UTC" }, {}, options)
      const elapsedMs = performance.now() - start
      const ids = found.items.map((h) => h.id)
      assert.equal(new Set(ids).size, ids.length)
      const grades = Object.values(q.relevant)
      const first = ids.findIndex((id) => q.relevant[id])
      const dcg = (g: number[]) => g.reduce((s, v, i) => s + (2 ** v - 1) / Math.log2(i + 2), 0)
      rows.push({
        id: q.id,
        category: q.category,
        ids,
        elapsedMs,
        recallAt10: grades.length ? ids.filter((id) => q.relevant[id]).length / grades.length : null,
        mrr: grades.length ? (first < 0 ? 0 : 1 / (first + 1)) : null,
        ndcgAt10: grades.length
          ? dcg(ids.map((id) => q.relevant[id] ?? 0)) / dcg([...grades].sort((a, b) => b - a).slice(0, 10))
          : null,
        falseHits: grades.length ? 0 : ids.length,
      })
      if (["phrase", "and", "or"].includes(q.category)) {
        const strict = await searchStore(store, account, {
          text: q.lucene,
          language: "lucene",
          timezone: "UTC",
          limit: 10,
        })
        assert.deepEqual(
          ids,
          strict.items.map((h) => h.id),
          `strict eligibility/order: ${q.id}`,
        )
      }
    }
    return rows
  }
  const dev = corpus.queries.filter((q) => q.split === "dev")
  const results = []
  for (const options of configurations) {
    const rows = await run(options, dev)
    results.push({ options, metrics: report(rows) })
  }
  const meetsGates = (m: ReturnType<typeof report>) =>
    m.recallAt10 >= 0.45 && m.mrr >= 0.5 && m.ndcgAt10 >= 0.4 && m.noAnswerFalseHits === 0
  const eligible = results.filter((r) => meetsGates(r.metrics))
  const chosen = [...(eligible.length ? eligible : results)].sort((a, b) =>
    eligible.length
      ? a.options.candidateDepth - b.options.candidateDepth ||
        b.metrics.ndcgAt10 - a.metrics.ndcgAt10 ||
        (a.metrics.p95Ms ?? 0) - (b.metrics.p95Ms ?? 0)
      : b.metrics.ndcgAt10 - a.metrics.ndcgAt10 ||
        b.metrics.recallAt10 - a.metrics.recallAt10 ||
        a.options.candidateDepth - b.options.candidateDepth,
  )[0]
  assert.ok(chosen)
  const chosenRows = await run(chosen.options, dev)
  // No held-out evaluation until a dev configuration meets the approved release gates.
  console.log(
    JSON.stringify(
      {
        corpusSha256: createHash("sha256").update(bytes).digest("hex"),
        productionSha256: Object.fromEntries(
          [
            "services/messages-combined.js",
            "services/messages-search.js",
            "search/lucene/parser.js",
            "search/correct.js",
            "search/stem.js",
            "store/normalize.js",
            "store/sqlite/lucene.js",
          ].map((file) => [
            file,
            createHash("sha256")
              .update(readFileSync(new URL(`../../dist/${file}`, import.meta.url)))
              .digest("hex"),
          ]),
        ),
        runnerSha256: createHash("sha256")
          .update(readFileSync(new URL("./combined.ts", import.meta.url)))
          .digest("hex"),
        configurations: results,
        devPassed: eligible.length > 0,
        chosen,
        devRankings: chosenRows,
        heldOut: eligible.length
          ? report(
              await run(
                chosen.options,
                corpus.queries.filter((q) => q.split === "test"),
              ),
            )
          : null,
      },
      null,
      2,
    ),
  )
} finally {
  await store.close()
}
