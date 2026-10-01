# Local embedding models under Node and Bun, with no native code — measured

2026-10-01/02, for [phase 5](../plans/phase-5.md). Scripts and raw results in
[`bench/embeddings/`](../../../bench/embeddings/): `bench.mjs` (run by `grid.sh`), `corpus.json` (the
queries and passages, written for this test), `results.jsonl`, `mem.mjs`, `tok.mjs`. The models
themselves are not committed.

Node 24.19.0, Bun 1.3.14; AMD Ryzen AI 9 HX 470, 12 cores / 24 threads, AVX-512 and VNNI — the laptop
the speech models were measured on.

## The runtime

- **`@huggingface/transformers` 4.3.0 always loads native code.** Its Node build imports
  `onnxruntime-node` and `sharp` at the top of the file. The default device works (Node 702 ms, Bun
  969 ms) only through `onnxruntime-node`, whose package carries prebuilt binaries for six platforms
  (288 MB). `device: "wasm"`: `Unsupported device: "wasm". Should be one of: cuda, webgpu, cpu.` With both
  native packages replaced by empty stubs: `Unable to load image processing library.` Its code also points
  the WASM runtime at a CDN when no local path is set (read in the code, not seen at run time). Installed:
  470 MB.
- **`onnxruntime-web` 1.30.0 with `@huggingface/tokenizers` 0.2.0 works under both.** Installed: 145 MB;
  opened by a run (traced on both runtimes): about 15 MB — `ort.node.min.mjs`,
  `ort-wasm-simd-threaded.mjs`, `ort-wasm-simd-threaded.wasm` (14 MB), `onnxruntime-common`, and the
  tokenizer (100 KB). The WASM file loads from the package, not a CDN. The JS tokenizer gives the same
  token ids as the reference Rust tokenizer (Python `tokenizers` 0.22.1) for every model below.
- Gemma's weights sit in a separate `.onnx_data` file that must be passed as `externalData`; without it:
  `Failed to load external data file "model_quantized.onnx_data", error: Module.MountedFiles is not
  available.`
- Default threads: Node takes min(4, cores / 2) = 4, Bun 1 (it defines `self` and has no
  `crossOriginIsolated`). `ort.env.wasm.numThreads = 4` works on Bun.

## The models

| model | repository @ commit | file | size | dims | licence |
|---|---|---|---|---|---|
| e5-small | `Xenova/multilingual-e5-small` @ `761b726d` | `onnx/model_quantized.onnx` | 118.3 + 17.1 MB | 384 | MIT, from `intfloat/multilingual-e5-small`; the Xenova copy states none |
| MiniLM | `Xenova/paraphrase-multilingual-MiniLM-L12-v2` @ `2c4055b1` | `onnx/model_quantized.onnx` | 118.3 + 17.1 MB | 384 | Apache-2.0, from `sentence-transformers`; trained on 128 tokens |
| Granite | `ibm-granite/granite-embedding-97m-multilingual-r2` @ `835ad140` | `onnx/model_quint8_avx2.onnx` | 98.2 + 25.3 MB | 384 | Apache-2.0; Russian among its enhanced languages; 32k tokens |
| Gemma int8 | `onnx-community/embeddinggemma-300m-ONNX` @ `5090578d` | `model_quantized.onnx` + `_data` | 309.5 + 20.3 MB | 768 | Gemma Terms of Use |
| Gemma 4-bit | same | `model_q4.onnx` + `_data` | 197.2 + 20.3 MB | 768 | Gemma Terms of Use |

"+" is the tokenizer file. `granite-embedding-107m-multilingual` has only a 428 MB full-precision ONNX
file. The Gemma terms ([ai.google.dev/gemma/terms](https://ai.google.dev/gemma/terms), modified
2026-04-01) require passing the §3.2 use restrictions on to every recipient, giving them a copy of the
terms and a notice, accepting Google's "right to restrict (remotely or otherwise) usage", and the
Prohibited Use Policy. `google/embeddinggemma-300m` is gated; the onnx-community copy is not.

sha256 of each file:

- e5: model `f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193`, tokenizer `0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39`
- MiniLM: model `66fc00f5f29afcaff34092e1bdd20008ca3918265a82fb9695a551e510cc4ebc`, tokenizer `b60b6b43406a48bf3638526314f3d232d97058bc93472ff2de930d43686fa441`
- Granite: model `a6022dd8220ea6f6595562a1328ee216f4a94faa55362f2f4747c80f1e78772e`, tokenizer `4f2842d568e2724370aec203652a42ac783c7937f8347a1a2cc7506d71f1582f`
- Gemma int8: model `172efde319fe1542dc41f31be6154910b05b78f7a861c265c4600eec906bd6d8`, data `705626e28e4c23c82ade34566b4197d97f534c12275fa406dfb71e9937d388c0`
- Gemma 4-bit: model `ad1dfee81a70f7944b9b9d1cc6e48075b832881cf33fab2f2b248be78f3f0043`, data `599962c3143b040de2dd05e5975be3e9091dd067cacc6a8f7186e3203bab9e02`
- Gemma, both sizes: the tokenizer file `4dda02faaf32bc91031dc8c88457ac272b00c1016cc679757d1c441b248b9c47`

## Speed, memory, and a sanity check of quality

Chunks of ~300 tokens per second, one at a time / batches of 8; load is the tokenizer plus the model
session; memory is the process's peak. Top-1: 10 Russian and English queries against 40 passages, as one
sentence ("short", ~17 tokens) and as that sentence hidden among ~40 lines of chat ("long", ~300 tokens),
measured on 4 threads only. Prefixes: e5 `query: ` / `passage: `, Gemma `task: search result | query: ` /
`title: none | text: `, MiniLM and Granite none (Granite's model card was not checked for one).

| model | runtime | threads | load ms | chunks/s single / batch | peak MB | top-1 short / long |
|---|---|---|---|---|---|---|
| e5 | node | 4 | 950 | 10.3 / 9.9 | 1227 | 6 / 7 |
| e5 | node | 1 | 962 | 3.3 / 3.4 | 1172 | |
| e5 | bun | 4 | 2568 | 4.4 / 5.8 † | 1122 | 6 / 7 |
| e5 | bun | 1 | 1170 | 4.2 / 3.9 | 1050 | |
| MiniLM | node | 4 | 1013 | 10.7 / 10.6 | 1178 | 10 / 3 |
| MiniLM | node | 1 | 3938 † | 2.1 / 4.3 | 1129 | |
| MiniLM | bun | 4 | 1116 | 10.1 / 10.6 | 1114 | 10 / 3 |
| MiniLM | bun | 1 | 1282 | 4.2 / 4.3 | 1003 | |
| Granite | node | 4 | 987 | 9.5 / 11.2 | 1011 | 8 / 5 |
| Granite | node | 1 | 937 | 4.3 / 4.1 | 967 | |
| Granite | bun | 4 | 964 | 10.0 / 10.3 | 959 | 7 / 5 |
| Granite | bun | 1 | 943 | 4.0 / 3.9 | 891 | |
| Gemma int8 | node | 4 | 1552 | 1.4 / 1.1 | 2081 | 10 / 9 |
| Gemma int8 | node | 1 | 1338 | 0.4 / 0.5 | 2031 | |
| Gemma int8 | bun | 4 | 1401 | 1.5 / 1.3 | 2252 | 10 / 9 |
| Gemma int8 | bun | 1 | 1285 | 0.5 / 0.6 | 2194 | |
| Gemma 4-bit | node | 4 | 1442 | 1.4 / 1.6 | 1234 | 10 / 10 |
| Gemma 4-bit | node | 1 | 1336 | 0.5 / 0.5 | 1194 | |
| Gemma 4-bit | bun | 4 | 1356 | 1.5 / 1.6 | 1161 | 10 / 10 |
| Gemma 4-bit | bun | 1 | not measured — stopped after 11 s of a ~2 min run | | | |

- † Disturbed by an install running at the same time; an earlier lone e5 run on Bun gave 6.2 / 5.9.
- Each number is one run, about ±20%. Ten queries is a sanity check: 5 against 7 is within its noise.
- Parsing the tokenizer adds 160–240 MB; creating the session 470–560 MB more.
- Batching to 8 gains little in WASM; 4 threads give about 2.5–3× one thread.
- Granite gave 8 on Node and 7 on Bun from the same files: probably a near-tie flipped by arithmetic order.
- Not measured: the native `onnxruntime-node` for comparison.

## Running in parallel

e5-small, 300-token chunks one at a time, 96 chunks after a warm-up, tokenized before timing. Script and
results in [`bench/embeddings/parallel/`](../../../bench/embeddings/parallel/) (`par.mjs`, `grid.sh`,
`results.jsonl`, `rerun.jsonl`). Workers are `node:worker_threads` on both runtimes, each with its own
session. The machine had 12 cores (24 threads) and about 7 GB free; load average rose to ~11 during the run.
Where a cell ran twice, both values are given; pairs differ by about 10%.

| sessions × threads | Node chunks/s | Node peak MB | Bun chunks/s | Bun peak MB | load ms Node / Bun |
|---|---|---|---|---|---|
| 1 × 1 | 4.0 | 1182 | 3.2 | 1037 | 585 / 830 |
| 1 × 2 | 6.9 | 1185 | 7.2 | 1069 | 677 / 607 |
| 1 × 4 | 10.2 / 10.4 | 1219 | 10.7 / 12.0 | 1116 | 618–1484 / 573–644 |
| 1 × 8 | 15.2 / 14.7 | 1284 | 15.6 / 14.8 | 1206 | 518 / 575 |
| 1 × 12 | 14.6 / 15.2 | 1341 | 15.7 / 14.8 | 1303 | 568 / 649 |
| 2 workers × 4 | 16.1 | 1785 | 16.4 | 1803 | 781 / 887 |
| 2 workers × 6 | 17.7 | 1864 | 17.1 | 1842 | 707 / 1037 |
| 3 workers × 4 | 18.5 / 19.6 | 2334 | 17.7 / 18.8 | 2368 | 815 / 1449 |
| 4 workers × 2 | 17.0 | 2753 | 17.9 | 2813 | 2121 / 1442 |
| 4 workers × 3 | 15.8 / 19.5 | 2829 | 20.2 / 19.8 | 2854 | 874 / 1808 |
| 6 workers × 1 | 15.8 | 3960 | 16.0 | 3763 | 1284 / 2042 |
| 6 workers × 2 | 18.8 / 22.8 | 4062 | 19.8 / 21.3 | 3859 | 1109 / 2829 |

- One session stops gaining at 8 threads. Workers do not share the model: each adds 550–650 MB.
- WASM threads work inside a worker on both runtimes (one worker on 4 threads ran 10.0–10.7 chunks/s
  against 3.2–4.0 on one; the process's thread count grew with the setting). Bun's own `Worker` was not tried.
- Best: 6 workers × 2, ~2.0× one session on 4 threads, at ~4 GB. 3 × 4: ~1.8× at ~2.3 GB. 1 × 8: ~1.45× at
  +60 MB.
