# Embedding and search by meaning — measurements

Phase 5 ([plan](../../docs/storage/plans/phase-5.md)). Two kinds of script live here:

- **`commands.mjs` and `commands.sh`** — item 8: the real commands (`conversations build`, `embed`,
  `search`) on the first N rows of [`bench/search`](../search/results.md)'s corpus as one group chat,
  with invented replies as in [`bench/disentangle/scale.ts`](../disentangle/scale.ts). A stub messenger
  that never connects runs them through `run()`, as a CLI's entry does. The model is the real e5-small
  from the shared folder.
- **The rest** (`bench.mjs`, `grid.sh`, `io*.mjs`, `mem.mjs`, `tok.mjs`, `parallel/`, `results.jsonl`) —
  the research of plan §3 that chose the model and the runtime, on `onnxruntime-web` directly.

```sh
pnpm build                                          # at the repository root
node bench/search/gen.ts 1000000 42                 # once; the corpus is shared by every worktree
bench/embeddings/commands.sh /tmp/embed-100k 100000 # about 90 minutes, most of it embedding
```

`commands.mjs warm <dir> <runs> <query>` is one process searching again and again with the model kept
open, as the MCP server does.

## 100k messages, 2026-10-02

AMD Ryzen AI 9 HX 470 (24 threads), 30 GB RAM, Linux 7.0, Node 24.19.0, Bun 1.3.14. Store on disk.
100,000 messages, 3 languages, 5–40 words each; one chat.

**Build and embed**

| step | runtime | time | peak RSS |
|---|---|---|---|
| `conversations build` | Node | 3.3 s | 331 MB |
| `conversations embed`, 1 worker | Node | 1,371 s (31 chunks/s) | 1.2 GB |
| `conversations embed`, 3 workers | Node | 1,240 s (34 chunks/s) | 2.6 GB |
| `conversations embed`, 1 worker | Bun | 1,329 s (32 chunks/s) | 3.2 GB |
| `conversations embed`, 3 workers | Bun | 1,279 s (33 chunks/s) | 2.7 GB |

42,417 chunks; the store grew to 292 MB. `embed status` estimated 2,828 s from e5-small's listed
15 chunks/s — twice the time it took.

**Search** — `search conversations --json`, the hybrid ranking of item 7. One-shot is the median of three
processes, start to exit; warm is the first and the median of ten more calls in one process.

| query | runtime | one-shot | warm, first | warm, median |
|---|---|---|---|---|
| `встреча` | Node | 2.69 s | 2.38 s | 1.64 s |
| `empadronamiento` (rare) | Node | 2.40 s | 2.16 s | 1.47 s |
| 9-word Russian sentence | Node | 2.43 s | 2.13 s | 1.43 s |
| 11-word English sentence | Node | 2.51 s (two runs) | 2.21 s | 1.57 s |
| `встреча` | Bun | 2.63 s | 2.72 s | 1.35 s |
| `empadronamiento` (rare) | Bun | 2.79 s | 2.14 s | 1.61 s |
| 9-word Russian sentence | Bun | 2.53 s | 2.63 s | 1.60 s |
| 11-word English sentence | Bun | 2.56 s | 2.46 s | 1.66 s |

One Node one-shot of the English sentence read 16,659 s: the laptop slept during it. It is left out.

What this says:

- **The vector scan is the cost, and its paging is why** (fixed — see below). A warm search, timed in parts: the query's
  vector 6 ms, the word search 25 ms, the scan 1.4 s. The scan reads 5,000 rows a step, ordered by
  conversation, and SQLite answers each step by reading every vector of the model and sorting them in a
  temporary B-tree: 9 steps cost 1.3 s, while the same rows in one statement come back in 166 ms. The
  query length does not matter, and neither does the runtime.
- **Workers barely help**: 1.1× with 3 on Node, 1.04× on Bun. **Correction 2026-10-03:** the research
  grid's ~1.8× compares 3 workers on 4 threads each against one session on **4 threads**, whereas this
  benchmark compares the default allocation against one session on **8 threads**. These gains are not
  directly comparable; option B retains the measured default allocation.
  One worker gets `min(8, cores)` = 8 threads; three get 2 each, 6 in all (`src/embeddings/pool.ts`), which
  probably explains it: the total threads do not grow. Not measured with more threads per worker.
- **Bun with one worker peaks at 3.2 GB**, Node at 1.2 GB, for the same run.
- A one-shot search pays ~1 s for loading the model on top of the scan; the MCP server keeps the model
  open, and pays the scan alone.

## After the scan fix, 2026-10-02

The scan's `CROSS JOIN` keeps the chunks first, so each page walks their key instead of re-reading and
sorting every vector. Same store, same machine, the 9-word Russian sentence:

| | before | after |
|---|---|---|
| the scan's statements, all pages | 1.3 s | 130–156 ms |
| warm, median of ten (Node) | 1.43 s | 0.35 s |
| warm, median of ten (Bun) | 1.60 s | 0.31 s |
| one-shot `встреча` (Node, three runs) | 2.67–2.75 s | 1.33–1.42 s |

