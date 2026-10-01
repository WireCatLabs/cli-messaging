import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads"
import { readFileSync, readdirSync } from "node:fs"

const base = new URL("../models/e5/", import.meta.url).pathname
const runtime = typeof Bun !== "undefined" ? `bun ${Bun.version}` : `node ${process.version}`
const hwm = () => Math.round(Number(readFileSync("/proc/self/status", "utf8").match(/VmHWM:\s+(\d+)/)[1]) / 1024)

const makeSession = async (threads) => {
  const ort = await import("onnxruntime-web")
  ort.env.wasm.numThreads = threads
  const session = await ort.InferenceSession.create(readFileSync(`${base}onnx/model_quantized.onnx`))
  const embed = async (ids) => {
    const len = ids.length
    const out = await session.run({
      input_ids: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, len]),
      attention_mask: new ort.Tensor("int64", new BigInt64Array(len).fill(1n), [1, len]),
      token_type_ids: new ort.Tensor("int64", new BigInt64Array(len), [1, len]),
    })
    const t = out.last_hidden_state, [, n, dim] = t.dims
    const v = new Float32Array(dim)
    for (let j = 0; j < n; j++) for (let k = 0; k < dim; k++) v[k] += t.data[j * dim + k] / n
    return v
  }
  return { embed, threads: ort.env.wasm.numThreads }
}

if (!isMainThread) {
  const { embed, threads } = await makeSession(workerData.threads)
  await embed(workerData.warm)
  parentPort.postMessage({ type: "ready", threads })
  parentPort.on("message", async (m) => {
    if (m.type === "stop") return process.exit(0)
    await embed(m.ids)
    parentPort.postMessage({ type: "done" })
  })
} else {
  const [workersArg, threadsArg, chunksArg] = process.argv.slice(2)
  const N = Number(workersArg), T = Number(threadsArg), C = Number(chunksArg || 64)
  const { Tokenizer } = await import("@huggingface/tokenizers")
  const corpus = JSON.parse(readFileSync(new URL("../ortweb/corpus.json", import.meta.url)))
  const tok = new Tokenizer(JSON.parse(readFileSync(`${base}tokenizer.json`)), JSON.parse(readFileSync(`${base}tokenizer_config.json`)))
  const chat = []
  for (let r = 0; r < 20; r++) corpus.passages.forEach((p, i) => chat.push(`${i % 2 ? "Аня" : "Slava"}: ${corpus.passages[(i * 7 + r * 3) % 40]}`))
  const all = tok.encode("passage: " + chat.join("\n")).ids
  const L = 300
  const chunk = (i) => [all[0], ...all.slice(1 + i * 50, 1 + i * 50 + L - 2), all[all.length - 1]]
  const maxStart = Math.floor((all.length - L) / 50)
  const chunks = Array.from({ length: C }, (_, i) => chunk(i % maxStart))
  const result = { runtime, workers: N, threadsPer: T, chunks: C, rssBeforeMB: hwm() }

  const t0 = performance.now()
  if (N === 0) {
    const { embed, threads } = await makeSession(T)
    await embed(chunk(0))
    result.threadsSeen = threads
    result.loadMs = Math.round(performance.now() - t0)
    const t = performance.now()
    for (const ids of chunks) await embed(ids)
    result.cps = +(C / ((performance.now() - t) / 1000)).toFixed(1)
  } else {
    const ws = Array.from({ length: N }, () => new Worker(new URL(import.meta.url), { workerData: { threads: T, warm: chunk(0) } }))
    const ready = await Promise.all(ws.map((w) => new Promise((ok, fail) => {
      w.once("error", fail)
      w.once("exit", (code) => fail(new Error(`worker exited ${code} before ready`)))
      w.once("message", (m) => ok(m))
    })))
    result.threadsSeen = ready.map((m) => m.threads)
    result.loadMs = Math.round(performance.now() - t0)
    let next = 0
    const t = performance.now()
    await Promise.all(ws.map((w) => new Promise((ok, fail) => {
      w.on("error", fail)
      const feed = () => (next < C ? w.postMessage({ type: "run", ids: chunks[next++] }) : ok())
      w.on("message", (m) => m.type === "done" && feed())
      feed()
    })))
    result.cps = +(C / ((performance.now() - t) / 1000)).toFixed(1)
    result.osThreads = readdirSync("/proc/self/task").length
    for (const w of ws) { w.removeAllListeners("exit"); w.postMessage({ type: "stop" }) }
  }
  result.osThreads ??= readdirSync("/proc/self/task").length
  result.peakRssMB = hwm()
  console.log(JSON.stringify(result))
  process.exit(0)
}
