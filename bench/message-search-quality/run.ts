import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Message } from "../../dist/domain/models.js"
import { searchStore } from "../../dist/services/messages.js"
import { openStore } from "../../dist/store/store.js"

type Mode = "lucene" | "legacy"
type Query = {
  id: string
  split: "dev" | "test"
  category: string
  intent: string
  lucene: string
  legacy: string
  relevant: Record<string, number>
}
type Corpus = {
  chats: { id: string; title: string }[]
  messages: Pick<Message, "id" | "chatId" | "senderId" | "timestamp" | "text">[]
  queries: Query[]
}
type Row = {
  id: string
  split: Query["split"]
  category: string
  mode: Mode
  text: string
  relevant: Record<string, number>
  hits: { id: string; chatId: string; match: string | null; score: number | null }[]
  corrections: { from: string; to: string[] }[]
  recallAt10: number | null
  mrr: number | null
  ndcgAt10: number | null
  noAnswerFalseHits: number
}

const corpusBytes = readFileSync(new URL("./corpus.json", import.meta.url))
const corpus = JSON.parse(corpusBytes.toString()) as Corpus
const ids = new Set(corpus.messages.map(({ id }) => id))
assert.equal(ids.size, corpus.messages.length)
assert.equal(new Set(corpus.queries.map(({ id }) => id)).size, corpus.queries.length)
for (const q of corpus.queries) {
  for (const [id, grade] of Object.entries(q.relevant)) {
    assert.ok(ids.has(id), `unknown relevance label ${id}`)
    assert.ok(grade === 1 || grade === 2)
  }
}
const root = mkdtempSync(join(tmpdir(), "message-search-quality-"))
const path = join(root, "quality.db")
// Set this before opening any store; the explicit path remains the authority.
process.env.TZ = "UTC"
process.env.MESSAGING_STORE = path
process.env.CLI_COMMON_CACHE_DIR = join(root, "empty-cache")
const account = { provider: "synthetic", account: "500" }
const store = await openStore({ path })
const rows: Row[] = []
try {
  await store.saveChats(account, corpus.chats.map((chat) => ({
    ...chat, kind: "group", unreadCount: 0, lastMessageAt: "2026-10-04T12:00:00.000Z", participantsCount: 100,
  })))
  for (const chat of corpus.chats) {
    await store.saveMessages(account, chat.id, corpus.messages.filter((m) => m.chatId === chat.id).map((m): Message => ({
      ...m, senderName: `Synthetic ${m.senderId}`, editedAt: null, outgoing: false, attachments: [],
      replyTo: null, forwardedFrom: null, reactions: null,
    })), { via: "synthetic" })
  }
  await store.fillSearchIndex({})
  await store.fillStems({})
  assert.equal((await store.searchIndexState())?.ready, true)
  for (const q of corpus.queries) {
    for (const mode of ["lucene", "legacy"] as const) {
      const found = await searchStore(store, account, {
        text: q[mode], language: mode, limit: 10,
        ...(mode === "lucene" ? { timezone: "UTC" } : {}),
      })
      assert.ok(found.wordsReady)
      if (mode === "lucene") assert.ok(found.stemsReady)
      const hits = found.items.map((h) => ({ id: h.id, chatId: h.chatId, match: h.match ?? null, score: h.score ?? null }))
      assert.equal(new Set(hits.map((h) => h.id)).size, hits.length)
      assert.ok(hits.every((h) => ids.has(h.id)))
      const grades = Object.values(q.relevant)
      const relevant = hits.filter((h) => q.relevant[h.id]).length
      const first = hits.findIndex((h) => q.relevant[h.id])
      const dcg = (g: number[]) => g.reduce((sum, grade, i) => sum + (2 ** grade - 1) / Math.log2(i + 2), 0)
      const ideal = dcg([...grades].sort((a, b) => b - a).slice(0, 10))
      rows.push({
        id: q.id, split: q.split, category: q.category, mode, text: q[mode], relevant: q.relevant, hits,
        corrections: found.corrections,
        recallAt10: grades.length ? relevant / grades.length : null,
        mrr: grades.length ? first < 0 ? 0 : 1 / (first + 1) : null,
        ndcgAt10: grades.length ? dcg(hits.map((h) => q.relevant[h.id] ?? 0)) / ideal : null,
        noAnswerFalseHits: grades.length ? 0 : hits.length,
      })
    }
  }
  assert.equal(rows.length, corpus.queries.length * 2)
  const summarize = (selected: Row[]) => {
    const answerable = selected.filter((r) => r.recallAt10 !== null)
    const negatives = selected.filter((r) => r.recallAt10 === null)
    const mean = (key: "recallAt10" | "mrr" | "ndcgAt10") => answerable.length
      ? answerable.reduce((sum, r) => sum + (r[key] ?? 0), 0) / answerable.length : null
    return {
      queries: selected.length, answerable: answerable.length, noAnswerQueries: negatives.length,
      recallAt10: mean("recallAt10"), mrr: mean("mrr"), ndcgAt10: mean("ndcgAt10"),
      noAnswerFalseHits: negatives.reduce((sum, r) => sum + r.noAnswerFalseHits, 0),
      noAnswerQueryHitRate: negatives.length ? negatives.filter((r) => r.hits.length > 0).length / negatives.length : null,
    }
  }
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
  const productionFiles = ["services/messages.js", "services/messages-search.js", "search/search.js", "search/query.js",
    "search/correct.js", "search/stem.js", "search/lucene/parser.js", "store/sqlite/lucene.js", "store/sqlite/words.js"]
  console.log(JSON.stringify({
    schemaVersion: 1, k: 10, node: process.version, timezone: "UTC", storePath: path,
    corpusSha256: digest(corpusBytes), runnerSha256: digest(readFileSync(fileURLToPath(import.meta.url))),
    productionSha256: Object.fromEntries(productionFiles.map((file) => [file, digest(readFileSync(new URL(`../../dist/${file}`, import.meta.url)))])),
    messages: corpus.messages.length, queries: corpus.queries.length,
    metrics: Object.fromEntries(["dev", "test"].map((split) => [split, Object.fromEntries(["lucene", "legacy"].map((mode) => {
      const selected = rows.filter((r) => r.split === split && r.mode === mode)
      return [mode, { ...summarize(selected), categories: Object.fromEntries([...new Set(selected.map((r) => r.category))]
        .map((category) => [category, summarize(selected.filter((r) => r.category === category))])) }]
    }))])),
    rankings: rows,
  }, null, 2))
} finally {
  await store.close()
}
