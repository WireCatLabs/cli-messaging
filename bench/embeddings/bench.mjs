import * as ort from "onnxruntime-web"
import { Tokenizer } from "@huggingface/tokenizers"
import { readFileSync, readdirSync } from "node:fs"

const [model, threadsArg, part] = process.argv.slice(2)
const runtime = typeof Bun !== "undefined" ? `bun ${Bun.version}` : `node ${process.version}`
const dir = `../models/${model}`
const spec = {
  e5: { file: "onnx/model_quantized.onnx", pool: "mean", q: "query: ", d: "passage: " },
  minilm: { file: "onnx/model_quantized.onnx", pool: "mean", q: "", d: "" },
  gemma: { file: "onnx/model_quantized.onnx", pool: "sentence_embedding", q: "task: search result | query: ", d: "title: none | text: " },
  gemmaq4: { dir: "gemma", file: "onnx/model_q4.onnx", pool: "sentence_embedding", q: "task: search result | query: ", d: "title: none | text: " },
  granite: { file: "onnx/model_quint8_avx2.onnx", pool: "cls", q: "", d: "" },
}[model]
const base = spec.dir ? `../models/${spec.dir}` : dir
if (threadsArg) ort.env.wasm.numThreads = Number(threadsArg)

const t0 = performance.now()
const tok = new Tokenizer(JSON.parse(readFileSync(`${base}/tokenizer.json`)), JSON.parse(readFileSync(`${base}/tokenizer_config.json`)))
const tTok = performance.now() - t0
const path = `${base}/${spec.file}`
const opts = {}
try { readFileSync(path + "_data", { flag: "r" }); opts.externalData = [{ path: spec.file.split("/").pop() + "_data", data: readFileSync(path + "_data") }] } catch {}
const session = await ort.InferenceSession.create(readFileSync(path), opts)
const tLoad = performance.now() - t0
const rssMB = () => Math.round(Number(readFileSync("/proc/self/status", "utf8").match(/VmHWM:\s+(\d+)/)[1]) / 1024)
const rssAfterLoad = rssMB()

const embed = async (rows) => {
  const len = rows[0].length
  const feeds = {
    input_ids: new ort.Tensor("int64", BigInt64Array.from(rows.flat().map(BigInt)), [rows.length, len]),
    attention_mask: new ort.Tensor("int64", new BigInt64Array(rows.length * len).fill(1n), [rows.length, len]),
  }
  if (session.inputNames.includes("token_type_ids")) feeds.token_type_ids = new ort.Tensor("int64", new BigInt64Array(rows.length * len), [rows.length, len])
  const out = await session.run(feeds)
  const vecs = []
  if (spec.pool === "sentence_embedding") {
    const t = out.sentence_embedding, dim = t.dims[1]
    for (let i = 0; i < rows.length; i++) vecs.push(t.data.slice(i * dim, (i + 1) * dim))
  } else {
    const t = out.last_hidden_state, [, n, dim] = t.dims
    for (let i = 0; i < rows.length; i++) {
      const v = new Float32Array(dim)
      if (spec.pool === "cls") v.set(t.data.subarray(i * n * dim, i * n * dim + dim))
      else for (let j = 0; j < n; j++) for (let k = 0; k < dim; k++) v[k] += t.data[(i * n + j) * dim + k] / n
      vecs.push(v)
    }
  }
  return vecs.map((v) => { const s = Math.hypot(...v); return v.map((x) => x / s) })
}

const corpus = JSON.parse(readFileSync("corpus.json"))
const result = { runtime, model, threads: ort.env.wasm.numThreads, tokenizerMs: Math.round(tTok), loadMs: Math.round(tLoad), rssAfterLoadMB: rssAfterLoad }

if (part !== "quality") {
  const chat = []
  for (let r = 0; r < 20; r++) corpus.passages.forEach((p, i) => chat.push(`${i % 2 ? "Аня" : "Slava"}: ${corpus.passages[(i * 7 + r * 3) % 40]}`))
  const ids = tok.encode(spec.d + chat.join("\n")).ids
  const L = 300
  const chunk = (i) => [ids[0], ...ids.slice(1 + i * 50, 1 + i * 50 + L - 2), ids[ids.length - 1]]
  await embed([chunk(0)])
  let t = performance.now()
  const N1 = 16
  for (let i = 0; i < N1; i++) await embed([chunk(i)])
  result.single_cps = +(N1 / ((performance.now() - t) / 1000)).toFixed(1)
  const B = 8, NB = 4
  await embed(Array.from({ length: B }, (_, i) => chunk(i)))
  t = performance.now()
  for (let b = 0; b < NB; b++) await embed(Array.from({ length: B }, (_, i) => chunk(b * B + i)))
  result.batch8_cps = +((B * NB) / ((performance.now() - t) / 1000)).toFixed(1)
}
if (part !== "speed") {
  let seed = 7
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const longDoc = (p) => {
    const lines = Array.from({ length: 40 }, () => corpus.filler[Math.floor(rnd() * corpus.filler.length)])
    lines.splice(Math.floor(rnd() * 40), 0, p)
    return lines.map((l, i) => `${i % 2 ? "Аня" : "Slava"}: ${l}`).join("\n")
  }
  const score = async (docs, label) => {
    const P = []
    let toks = 0
    for (const p of docs) { const ids = tok.encode(spec.d + p).ids; toks += ids.length; P.push((await embed([ids]))[0]) }
    let hits = 0
    const misses = []
    for (const [q, want] of corpus.queries) {
      const v = (await embed([tok.encode(spec.q + q).ids]))[0]
      const scores = P.map((p) => p.reduce((s, x, k) => s + x * v[k], 0))
      const best = scores.indexOf(Math.max(...scores))
      if (best === want) hits++
      else misses.push(`${q} -> #${best}`)
    }
    result.dims = P[0].length
    result[`top1_${label}`] = `${hits}/10`
    result[`avgTokens_${label}`] = Math.round(toks / docs.length)
    if (misses.length) result[`misses_${label}`] = misses
  }
  await score(corpus.passages, "short")
  await score(corpus.passages.map(longDoc), "long")
}
result.osThreads = readdirSync("/proc/self/task").length
result.maxRssMB = rssMB()
console.log(JSON.stringify(result))
