import { readFileSync, existsSync } from "node:fs"
import { performance } from "node:perf_hooks"
import { openCrossEncoder } from "./crossencoder.ts"
const before = process.memoryUsage()
const started = performance.now()
const directory = process.env.MESSAGE_RERANKER_DIR
if (!directory) throw new Error("MESSAGE_RERANKER_DIR must name the separately prepared local model")
const ranker = await openCrossEncoder(directory)
const afterLoad = process.memoryUsage()
const loadMs = performance.now() - started
const modelScore = await ranker.score(
  "What rollback decision was agreed for the Aurora rollout?",
  "Aurora rollout rollback decision: disable the canary and restore build 17.",
)
const afterFirst = process.memoryUsage()
let peakRss = afterFirst.rss
const start = performance.now()
for (let i = 0; i < 300; i++) {
  await ranker.score(
    "What rollback decision was agreed for the Aurora rollout?",
    `Aurora rollout rollback: agenda only; no decision yet. Thread ${i}.`,
  )
  peakRss = Math.max(peakRss, process.memoryUsage().rss)
}
const after300 = process.memoryUsage()
const scoring300Ms = performance.now() - start
const highWaterKiB = existsSync("/proc/self/status")
  ? Number(/^VmHWM:\s+(\d+)/m.exec(readFileSync("/proc/self/status", "utf8"))?.[1])
  : process.resourceUsage().maxRSS
await ranker.close()
const report = {
  model: ranker.model,
  node: process.version,
  before,
  afterLoad,
  afterFirst,
  after300,
  peakObservedRss: peakRss,
  processHighWaterBytes: highWaterKiB * 1024,
  modelIncrementAtLoad: afterLoad.rss - before.rss,
  modelIncrementAfter300: after300.rss - before.rss,
  loadMs,
  scoring300Ms,
  score: modelScore,
  notes:
    "Entire isolated Node process RSS includes runtime, tokenizer, model weights and buffers; no store or account opened.",
}
console.log(JSON.stringify(report))
