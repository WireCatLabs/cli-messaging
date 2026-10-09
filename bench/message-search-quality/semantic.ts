import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { cpus, tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import type { Message } from "../../dist/domain/models.js"
import { isTextModelInstalled, openEmbedder, textModelsDirectory } from "../../dist/embeddings/embed.js"
import { textModel } from "../../dist/embeddings/models.js"
import { searchCombined } from "../../dist/services/messages-combined.js"
import { openStore } from "../../dist/store/store.js"
import { openCrossEncoder } from "./crossencoder.ts"

type Query = { id: string; split: "dev" | "test"; category: string; lucene: string; relevant: Record<string, number> }
type Question = {
  id: string
  split: "dev" | "test"
  category: string
  retrieval: string
  text: string
  relevant: Record<string, number>
}
type Seed = {
  chats: { id: string; title: string }[]
  messages: Pick<Message, "id" | "chatId" | "senderId" | "timestamp" | "text">[]
}
type Ranking = { id: string; score: number }
type Metrics = { recallAt10: number | null; mrr: number | null; ndcgAt10: number | null; falseHits: number }
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
const originalBytes = readFileSync(new URL("./corpus.json", import.meta.url))
const questionBytes = readFileSync(new URL("./questions.json", import.meta.url))
const corpus = JSON.parse(originalBytes.toString()) as Seed & { queries: Query[] }
const supplement = JSON.parse(questionBytes.toString()) as Seed & { queries: Question[] }
const root = mkdtempSync(join(tmpdir(), "semantic-message-quality-"))
const crossEncoderMode = process.argv.includes("--crossencoder")
const floors: (number | null)[] = crossEncoderMode
  ? [null, -5, -2, -1, 0, 1, 2, 3, 5, 8]
  : [null, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95]
const crossEncoderDirectory = process.env.MESSAGE_RERANKER_DIR
if (crossEncoderMode)
  assert.ok(crossEncoderDirectory, "MESSAGE_RERANKER_DIR must name a separately prepared local model")
const directory = textModelsDirectory()
const model = textModel("e5-small")
if (!crossEncoderMode)
  assert.ok(
    isTextModelInstalled(model, directory),
    "Install the pinned model separately before running; this benchmark never downloads it",
  )
if (!crossEncoderMode)
  for (const file of model.files)
    assert.equal(digest(readFileSync(join(directory, model.id, file.name))), file.sha256, `pinned model ${file.name}`)
process.env.TZ = "UTC"
process.env.MESSAGING_STORE = join(root, "quality.db")
process.env.CLI_COMMON_CACHE_DIR = join(root, "empty-cache")
const store = await openStore({ path: process.env.MESSAGING_STORE })
const account = { provider: "synthetic", account: "500" }
const depths = [50, 100, 300, 500]
const seeds = [corpus, supplement]
const allMessages = seeds.flatMap((seed) => seed.messages)
const messages = new Map(allMessages.map((m) => [m.id, m]))
const vectorCache = new Map<string, Float32Array>()
const queryCache = new Map<string, Float32Array>()
const modeFiles = [
  "services/messages-combined.js",
  "search/lucene/parser.js",
  "embeddings/embed.js",
  "embeddings/models.js",
  "store/sqlite/lucene.js",
]
const frozenInputs = {
  crossEncoderImplementationSha256: digest(readFileSync(new URL("./crossencoder.ts", import.meta.url))),
  rerankerManifestSha256: digest(readFileSync(new URL("./reranker.json", import.meta.url))),
  corpusSha256: digest(originalBytes),
  questionsSha256: digest(questionBytes),
  runnerSha256: digest(readFileSync(new URL("./semantic.ts", import.meta.url))),
  productionSha256: Object.fromEntries(
    modeFiles.map((file) => [file, digest(readFileSync(new URL(`../../dist/${file}`, import.meta.url)))]),
  ),
}
writeFileSync(join(root, "frozen-inputs.json"), JSON.stringify(frozenInputs, null, 2))
const metrics = (rankings: Ranking[], relevant: Record<string, number>): Metrics => {
  const ids = rankings.slice(0, 10).map((h) => h.id)
  const grades = Object.values(relevant)
  if (!grades.length) return { recallAt10: null, mrr: null, ndcgAt10: null, falseHits: ids.length }
  const first = ids.findIndex((id) => relevant[id])
  const dcg = (g: number[]) => g.reduce((s, v, i) => s + (2 ** v - 1) / Math.log2(i + 2), 0)
  return {
    recallAt10: ids.filter((id) => relevant[id]).length / grades.length,
    mrr: first < 0 ? 0 : 1 / (first + 1),
    ndcgAt10: dcg(ids.map((id) => relevant[id] ?? 0)) / dcg([...grades].sort((a, b) => b - a).slice(0, 10)),
    falseHits: 0,
  }
}
const summarize = (rows: Metrics[]) => {
  const answered = rows.filter((row) => row.recallAt10 !== null)
  const avg = (key: "recallAt10" | "mrr" | "ndcgAt10") =>
    answered.length ? answered.reduce((s, r) => s + (r[key] ?? 0), 0) / answered.length : 0
  return {
    answerable: answered.length,
    noAnswerQueries: rows.length - answered.length,
    recallAt10: avg("recallAt10"),
    mrr: avg("mrr"),
    ndcgAt10: avg("ndcgAt10"),
    noAnswerFalseHits: rows.reduce((s, r) => s + r.falseHits, 0),
  }
}
const options = (depth: number) => ({ candidateDepth: depth, rrfK: 60, rerank: "none" as const, chatCap: 0 })
const pool = async (text: string, depth: number) => {
  const found = await searchCombined(store, account, { text, limit: depth, timezone: "UTC" }, {}, options(depth))
  assert.equal(new Set(found.items.map((h) => h.id)).size, found.items.length)
  assert.ok(found.items.every((h) => messages.has(h.id)))
  return {
    hits: found.items.map((h) => ({ id: h.id, score: h.score ?? 0 })),
    expanded: found.query.combined.expanded,
    truncated: found.hasMore,
  }
}
const cosine = (a: Float32Array, b: Float32Array) => {
  assert.equal(a.length, b.length)
  let score = 0
  for (let i = 0; i < a.length; i++) score += (a[i] ?? 0) * (b[i] ?? 0)
  return score
}
let embedder: Awaited<ReturnType<typeof openEmbedder>> | undefined
let crossEncoder: Awaited<ReturnType<typeof openCrossEncoder>> | undefined
const pairCache = new Map<string, number>()
let pairInferenceMs = 0,
  scoredPairs = 0
let passageInferenceMs = 0,
  queryInferenceMs = 0,
  embeddedMessages = 0
const rerank = async (text: string, candidates: Ranking[]) => {
  if (crossEncoder) {
    const ranked = []
    const start = performance.now()
    for (const [lexicalRank, hit] of candidates.entries()) {
      const key = JSON.stringify([text, hit.id])
      let score = pairCache.get(key)
      if (score === undefined) {
        assert.ok(scoredPairs < 20000, "bounded experimental pair budget")
        score = await crossEncoder.score(text, messages.get(hit.id)?.text ?? "")
        pairCache.set(key, score)
        scoredPairs++
      }
      ranked.push({ id: hit.id, score, lexicalRank })
    }
    pairInferenceMs += performance.now() - start
    console.error(`Scored ${scoredPairs} synthetic query-message pairs`)
    return ranked.sort((a, b) => b.score - a.score || a.lexicalRank - b.lexicalRank)
  }
  assert.ok(embedder)
  let query = queryCache.get(text)
  if (!query) {
    const start = performance.now()
    const [vector] = await embedder.embed([text], "query")
    assert.ok(vector)
    query = vector
    queryCache.set(text, query)
    queryInferenceMs += performance.now() - start
  }
  const missing = candidates.filter((hit) => !vectorCache.has(hit.id))
  if (missing.length) {
    const start = performance.now()
    const vectors = await embedder.embed(
      missing.map((hit) => messages.get(hit.id)?.text ?? ""),
      "passage",
    )
    assert.equal(vectors.length, missing.length)
    missing.forEach((hit, i) => {
      const vector = vectors[i]
      assert.ok(vector)
      vectorCache.set(hit.id, vector)
    })
    passageInferenceMs += performance.now() - start
    embeddedMessages += missing.length
    console.error(`Embedded ${embeddedMessages} synthetic candidates; no network or model download`)
  }
  return candidates
    .map((hit, rank) => {
      const vector = vectorCache.get(hit.id)
      assert.ok(vector)
      return { id: hit.id, score: cosine(query, vector), lexicalRank: rank }
    })
    .sort((a, b) => b.score - a.score || a.lexicalRank - b.lexicalRank)
}
try {
  for (const seed of seeds) {
    await store.saveChats(
      account,
      seed.chats.map((c) => ({ ...c, kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 100 })),
    )
    for (const chat of seed.chats)
      await store.saveMessages(
        account,
        chat.id,
        seed.messages
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
  }
  await store.fillSearchIndex({})
  await store.fillStems({})
  const dev = corpus.queries.filter((q) => q.split === "dev")
  const candidateRows: (Metrics & {
    id: string
    category: string
    depth: number
    relevant: Record<string, number>
    candidateIds: string[]
    candidateRecall: number | null
    truncated: boolean
  })[] = []
  for (const q of dev) {
    for (const depth of depths) {
      const candidates = await pool(q.lucene, depth)
      const labels = Object.keys(q.relevant)
      candidateRows.push({
        id: q.id,
        category: q.category,
        depth,
        relevant: q.relevant,
        candidateIds: candidates.hits.map((h) => h.id),
        candidateRecall: labels.length
          ? labels.filter((id) => candidates.hits.some((h) => h.id === id)).length / labels.length
          : null,
        ...metrics(candidates.hits, q.relevant),
        truncated: candidates.truncated,
      })
    }
  }
  const candidateSummary = depths.map((depth) => {
    const rows = candidateRows.filter((r) => r.depth === depth && r.candidateRecall !== null)
    return {
      depth,
      candidateRecall: rows.reduce((s, r) => s + (r.candidateRecall ?? 0), 0) / rows.length,
      byCategory: Object.fromEntries(
        [...new Set(rows.map((r) => r.category))].map((category) => {
          const selected = rows.filter((r) => r.category === category)
          return [category, selected.reduce((s, r) => s + (r.candidateRecall ?? 0), 0) / selected.length]
        }),
      ),
    }
  })
  const maxCandidateRecall = Math.max(...candidateSummary.map((r) => r.candidateRecall))
  const selectedDepth = candidateSummary.find((r) => r.candidateRecall === maxCandidateRecall)?.depth ?? 500
  console.error(`Dev candidate recall measured; selected depth ${selectedDepth} on dev only`)
  const loaded = performance.now()
  if (crossEncoderMode) {
    assert.ok(crossEncoderDirectory)
    crossEncoder = await openCrossEncoder(crossEncoderDirectory)
  } else embedder = await openEmbedder(model, directory, { threads: 8 })
  const loadMs = performance.now() - loaded
  const keywordRows = []
  for (const q of dev) {
    const candidates = await pool(q.lucene, selectedDepth)
    const semantic = candidates.expanded ? await rerank(q.lucene, candidates.hits) : candidates.hits
    keywordRows.push({
      id: q.id,
      category: q.category,
      relevant: q.relevant,
      lexical: candidates.hits.slice(0, 10),
      semantic: semantic.slice(0, 10),
      lexicalMetrics: metrics(candidates.hits, q.relevant),
      semanticMetrics: metrics(semantic, q.relevant),
      expanded: candidates.expanded,
    })
  }
  const questionRows: {
    id: string
    category: string
    relevant: Record<string, number>
    directMetrics: Metrics
    anchorMetrics: Metrics
    directCandidateCount: number
    anchoredCandidateCount: number
    semantic: Ranking[]
    lexical: Ranking[]
  }[] = []
  for (const q of supplement.queries.filter((q) => q.split === "dev")) {
    const direct = await pool(q.text, selectedDepth)
    const anchored = await pool(q.retrieval, selectedDepth)
    const semantic = await rerank(q.text, anchored.hits)
    questionRows.push({
      id: q.id,
      category: q.category,
      relevant: q.relevant,
      directMetrics: metrics(direct.hits, q.relevant),
      anchorMetrics: metrics(anchored.hits, q.relevant),
      directCandidateCount: direct.hits.length,
      anchoredCandidateCount: anchored.hits.length,
      semantic,
      lexical: anchored.hits.slice(0, 10),
    })
  }
  const keywordSummary = {
    lexical: summarize(keywordRows.map((r) => r.lexicalMetrics)),
    semantic: summarize(keywordRows.map((r) => r.semanticMetrics)),
  }
  const questionSweep = floors.map((floor) => ({
    floor,
    metrics: summarize(
      questionRows.map((r) =>
        metrics(
          r.semantic.filter((h) => floor === null || h.score > floor),
          r.relevant,
        ),
      ),
    ),
  }))
  const passing = (m: ReturnType<typeof summarize>) =>
    m.recallAt10 >= 0.45 && m.mrr >= 0.5 && m.ndcgAt10 >= 0.4 && m.noAnswerFalseHits === 0
  const eligible = questionSweep.filter((row) => passing(row.metrics))
  const chosen = [...(eligible.length ? eligible : questionSweep)].sort(
    (a, b) => a.metrics.noAnswerFalseHits - b.metrics.noAnswerFalseHits || b.metrics.ndcgAt10 - a.metrics.ndcgAt10,
  )[0]
  assert.ok(chosen)
  const devQualified = passing(keywordSummary.semantic) && eligible.length > 0
  const heldOutKeywordRows: {
    id: string
    metrics: Metrics
    lexicalMetrics: Metrics
    relevant: Record<string, number>
    hits: Ranking[]
  }[] = []
  const heldOutRows = []
  if (devQualified) {
    for (const q of corpus.queries.filter((q) => q.split === "test")) {
      const candidates = await pool(q.lucene, selectedDepth)
      const ranked = candidates.expanded ? await rerank(q.lucene, candidates.hits) : candidates.hits
      heldOutKeywordRows.push({
        id: q.id,
        relevant: q.relevant,
        hits: ranked.slice(0, 10),
        metrics: metrics(ranked, q.relevant),
        lexicalMetrics: metrics(candidates.hits, q.relevant),
      })
    }
    for (const q of supplement.queries.filter((q) => q.split === "test")) {
      const candidates = await pool(q.retrieval, selectedDepth)
      const ranked = await rerank(q.text, candidates.hits)
      const hits = ranked.filter((h) => chosen.floor === null || h.score > chosen.floor)
      heldOutRows.push({ id: q.id, relevant: q.relevant, hits: hits.slice(0, 10), metrics: metrics(hits, q.relevant) })
    }
  }
  console.log(
    JSON.stringify(
      {
        ...frozenInputs,
        node: process.version,
        cpu: cpus()[0]?.model,
        storePath: process.env.MESSAGING_STORE,
        model: crossEncoder?.model ?? {
          id: model.id,
          files: model.files.map(({ name, sha256 }) => ({ name, sha256 })),
          threads: 8,
        },
        kind: crossEncoderMode
          ? "cross-encoder raw logit reranking"
          : "embedding-cosine reranking; not a cross-encoder",
        candidateSummary,
        selectedOnDev: { depth: selectedDepth, questionScoreFloor: chosen.floor },
        keywordSummary,
        questionSummary: {
          direct: summarize(questionRows.map((r) => r.directMetrics)),
          anchoredLexical: summarize(questionRows.map((r) => r.anchorMetrics)),
          sweep: questionSweep,
        },
        devQualified,
        questionRetrieval:
          "manual topic anchors for diagnostic reranking; full-question direct retrieval is measured separately",
        heldOut: devQualified
          ? {
              keyword: {
                lexical: summarize(heldOutKeywordRows.map((r) => r.lexicalMetrics)),
                semantic: summarize(heldOutKeywordRows.map((r) => r.metrics)),
                rows: heldOutKeywordRows,
              },
              questions: { metrics: summarize(heldOutRows.map((r) => r.metrics)), rows: heldOutRows },
            }
          : null,
        inference: {
          pairInferenceMs,
          scoredPairs,
          averagePairMs: scoredPairs ? pairInferenceMs / scoredPairs : null,
          loadMs,
          embeddedMessages,
          uniqueEmbeddedQueries: queryCache.size,
          uniqueCrossEncoderQueries: new Set(
            [...pairCache.keys()].map((key) => (JSON.parse(key) as [string, string])[0]),
          ).size,
          passageInferenceMs,
          queryInferenceMs,
          amortizedPerMessageMs: embeddedMessages ? passageInferenceMs / embeddedMessages : null,
          cache: crossEncoderMode
            ? "exact synthetic query-message score cache, empty at run start"
            : "new in-memory synthetic message vectors; no persistent production message index",
        },
        candidateRows,
        keywordRows,
        questionRows: questionRows.map((row) => ({ ...row, semantic: row.semantic.slice(0, 10) })),
      },
      null,
      2,
    ),
  )
} finally {
  await crossEncoder?.close()
  await embedder?.close()
  await store.close()
}
