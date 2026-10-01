import { readFileSync } from "node:fs"
const rss = () => Math.round(Number(readFileSync("/proc/self/status", "utf8").match(/VmRSS:\s+(\d+)/)[1]) / 1024)
const m = process.argv[2], f = process.argv[3]
const out = { base: rss() }
const { Tokenizer } = await import("@huggingface/tokenizers")
new Tokenizer(JSON.parse(readFileSync(`../models/${m}/tokenizer.json`)), JSON.parse(readFileSync(`../models/${m}/tokenizer_config.json`)))
globalThis.gc?.(); out.afterTokenizer = rss()
const ort = await import("onnxruntime-web"); ort.env.wasm.numThreads = 1
const s = await ort.InferenceSession.create(readFileSync(`../models/${m}/${f}`))
globalThis.gc?.(); out.afterSession = rss()
console.log(m, JSON.stringify(out))
