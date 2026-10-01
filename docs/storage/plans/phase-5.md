# Phase 5 — search by meaning over a chat's conversations

Plan, 2026-10-02. **Draft, not approved; nothing is built.** It follows [`../decisions.md`](../decisions.md):
embeddings are computed **locally**, by one small multilingual model or a short list, kept in the folder the
speech models already share (NEED-412 A); they go on chunks of conversations, never on single messages,
and are never used to link messages. Requirements §18, §19 and "Phase 5" ask for `conversation_documents`,
pgvector, embedding providers, semantic search and RRF hybrid search, "only for explicitly enriched chats".
What is kept and what is replaced is named in the E-decisions below.

Evidence labels as in the rest of this folder: **verified** has a `path:line` at a named commit or a
measurement in §3, **docs say** names the source, **inferred** is reasoning. Code read at `main` `df15e6b`.

## 1. Goal

At the end of phase 5, for a chat whose conversations are built (phases 3–4):

- `models text list|download` lists and fetches the embedding models, as `models audio` does for speech;
- `conversations embed --chat <chat>` cuts the chat's conversations into chunks and computes a vector for
  each chunk that has none, on this machine; it can stop and resume, and a rebuild re-embeds only the
  chunks whose text changed;
- `conversations search "<query>"` finds the conversations nearest in meaning, in one chat or every
  embedded one, and — once phase 2's search service is in — ranks them together with the word search;
- MCP `conversations_search` does the same for agents.

Nothing leaves the machine. No API key, no network except the one-time model download.

## 2. Depends on

- **Phase 3–4 merged and released** — conversations and agent links ([`phase-3.md`](phase-3.md),
  [`phase-4.md`](phase-4.md)): a chunk is cut from a conversation of the current build.
- **Phase 2's search service** ([`phase-2.md`](phase-2.md) item 6) for the hybrid ranking only (item 6
  below). Everything before item 6 works without it. Phase 2's files (`src/store/sqlite/search*`,
  `words.ts`, `src/search/`) are not edited here.
- **Store version 14**, taken in [the lanes plan](../../plans/2026-09-29-parity-lanes.md) by a PR of its
  own before item 2 (E8).

## 3. What we know

Measured 2026-10-01/02 on the laptop the speech models were measured on (Ryzen AI 9 HX 470, 12 cores),
Node 24.19 and Bun 1.3.14, in a scratch folder, with synthetic data only.

**Running a model.** **Verified:** `@huggingface/transformers` 4.3 always loads native code — its Node
build imports `onnxruntime-node` (288 MB of binaries for six platforms) and `sharp` at the top; its WASM
device is refused (`Unsupported device: "wasm"`). `onnxruntime-web` 1.30 called directly, with
`@huggingface/tokenizers` 0.2 (pure JS, same token ids as the reference tokenizer for every model below),
runs under both runtimes with no native code. It installs 145 MB, of which a run opens about 15 MB
(`ort.node.min.mjs`, `ort-wasm-simd-threaded.{mjs,wasm}`). Node picks 4 threads by default, Bun 1; setting
`ort.env.wasm.numThreads` works on both. Speech's `sherpa-onnx` installs 15 MB, for comparison.

**Models**, int8 or 4-bit ONNX, each pinned to a commit and a sha256. Speed is 300-token chunks per second
on 4 threads; "top-1" is 10 Russian and English queries against 40 passages, as one sentence and hidden in
~300 tokens of chat — a sanity check, not a benchmark:

| model | licence | size | dims | chunks/s | memory | top-1 sentence / chunk |
|---|---|---|---|---|---|---|
| `granite-embedding-97m-multilingual-r2` | Apache-2.0 | 98 + 25 MB | 384 | ~10 | ~1.0 GB | 8 / 5 |
| `multilingual-e5-small` | MIT | 118 + 17 MB | 384 | ~10 | ~1.2 GB | 6 / 7 |
| `paraphrase-multilingual-MiniLM-L12-v2` | Apache-2.0 | 118 + 17 MB | 384 | ~10 | ~1.2 GB | 10 / **3** |
| `embeddinggemma-300m`, 4-bit | Gemma Terms of Use | 197 + 20 MB | 768 | ~1.5 | ~1.2 GB | **10 / 10** |
| `embeddinggemma-300m`, int8 | Gemma Terms of Use | 310 + 20 MB | 768 | ~1.4 | ~2.1 GB | 10 / 9 |

MiniLM was trained on 128 tokens, which its score on chunks shows. The Gemma terms are not an open licence:
use restrictions passed on to every recipient, a copy of the terms with the model, and Google's right to
restrict use ([terms](https://ai.google.dev/gemma/terms)). Each number is one run, ±20%.

**Storing and scanning vectors.** **Verified:** sqlite-vec 0.1.9 (pre-v1, "expect breaking changes") loads
on official Node 22 and 24 (`allowExtension`) and Bun on Linux; on musl only built by us. A plain table of
float32 BLOBs scanned with a dot product in JS is as fast as sqlite-vec's `vec0` at every size tried:

| vectors × dims | file | first query (reads the table) | warm, in memory | `vec0` |
|---|---|---|---|---|
| 10k × 384 | 20 MB | 27–49 ms | 3 ms | 5 ms |
| 100k × 384 | 196 MB | 0.2–0.5 s | 26–40 ms | 44–56 ms |
| 100k × 768 | 392 MB | 0.3–0.5 s | 54–56 ms | 88–100 ms |
| 1M × 384 | 1.96 GB | 1.6–3.2 s | 0.25 s | 0.41 s |

First queries read from the page cache, not a cold disk. int8 vectors take a quarter of the space at the
same speed. macOS and arm64 were not measured.

**What a chat costs (inferred).** Phase 3's scale run made 36,612 conversations of 100,000 synthetic messages
([`bench/disentangle/README.md`](../../../bench/disentangle/README.md)), most of one or two messages. At
~10 chunks a second that chat embeds in about an hour; at Gemma's ~1.5, about seven. A 5,000-message group
takes minutes with either.

## 4. Decisions made here

**E1 · A chunk is a conversation, or a run of its messages.** The current build's conversations of an
embedded chat, in order; a conversation longer than `CHUNK_TOKENS` (300, the measured size) is cut at
message boundaries into consecutive pieces. The chunk's text is one line per message, `sender: text`,
which the model sees and nothing else. One-message conversations are chunks too: search has to find them.

**E2 · Vectors are keyed by what they encode, not by the conversation.** A rebuild writes new
conversation rows (`conversations.build`, `src/store/sqlite/schema.ts:339`), so a vector tied to a
conversation row would be thrown away by every rebuild. Instead:

- `conversation_chunks (conversation_pk, ordinal, first_message_pk, last_message_pk, content_hash)` —
  derived per build, cascading with the conversation, written by `replaceConversations` with the rest of
  the build;
- `chunk_vectors (model, content_hash, dims, vector BLOB, created_at)`, primary key `(model,
  content_hash)` — the hash is sha256 of the chunk text and the model's input prefix.

A rebuild that leaves a conversation's text alone leaves its hash alone, and the vector is reused.
This replaces requirements §18's `conversation_embeddings(conversation_id, …)` and keeps its reasons:
several models side by side, rebuildable, droppable without touching `messages`. `store check` counts vectors no chunk points at;
`conversations embed --clear` drops them.

**E3 · Vectors in a plain table, scanned in JS** — no extension (**NEED-518**). Float32, normalised at
write so a dot product is the cosine. A search reads the scope's vectors in one statement and keeps the
top `--limit`; `serve` and `mcp` keep what they read in memory between queries. sqlite-vec's ruled role
(NEED-374 A) is not needed at the sizes measured, and it would add an extension per platform that official
Node and Bun on Linux load from outside our SQLite. int8 storage and sqlite-vec stay open for when a real
archive passes ~100k chunks.

**E4 · The runtime is downloaded with the model, not installed with the package.** `onnxruntime-web`'s
three runtime files (about 15 MB) go into `~/.cache/cli-common/models/` beside the model, pinned by sha256
like every model file (`src/speech/install.ts:67`); `@huggingface/tokenizers` (0.4 MB) is a plain
dependency. Installing `onnxruntime-web` as a dependency would add 145 MB to every tg and max install
whether anyone embeds or not — what the owner asked to avoid. **Inferred:** loading the runtime from that
folder through `import()` of a file URL and `ort.env.wasm.wasmPaths`; item 1 proves it on both runtimes,
and if it fails the fallback is a dependency, said in the PR.

**E5 · Models: a short list, like speech.** `src/embeddings/models.ts` lists them, most suitable first, each
with its input prefixes (Gemma's `task: search result | query: `, e5's `query: ` and `passage: `), its
token limit and its files. The default is **NEED-517**. Threads: `min(4, cores / 2)`, set explicitly,
since Bun otherwise takes 1.

**E6 · Opt-in per chat, run by the user.** `conversations embed --chat <chat> [--model <id>]` embeds only
a chat whose conversations are built, prints how many chunks are left and the estimate first (on stderr),
then embeds in batches of 8, one short transaction per batch, progress on stderr. Stopping loses at most
one batch; running it again continues. No consent step: nothing leaves the machine, and it spends only
the user's own time, which the estimate states. `--clear [--model <id>]` drops the chat's vectors.
`conversations embed status` lists embedded chats, chunks done and left, per model.

**E7 · Search.** `conversations search "<query>" [--chat <chat>] [--model <id>] [--limit 10]
[--since-time]`: embeds the query with the same model, scans the chunks of the current build of every
embedded chat in scope, and prints conversations, best first, with the matching chunk's first and last
message and a score; `--json` gives the conversation ids that `conversations show` takes. A chat embedded
with no model the query uses is named on stderr, not searched silently. One-shot cost: model load
~1–1.5 s, then the scan (§3).

**E8 · Store version 14, additive.** The two tables of E2. `min_compatible` stays 6. Taken in the lanes
plan first.

**E9 · Hybrid ranking is the last item.** When phase 2's service exists, `conversations search` also runs
the word search in the same scope, maps its hits to their conversations, and merges the two lists by
reciprocal rank fusion (requirements §21; k = 60, the usual constant, until the item 6 set says otherwise). Until then the command ranks by meaning only and says
so in its help. `messages search` itself is not changed here.

**E10 · Permissions and machine mode.** `conversations embed` writes only to the local store — the key
`conversations.embed`, so a profile read-only on messages can still embed, as phase 4's
`conversations.links`; `conversations search` shows message text and is checked as `messages`. In machine
mode stdout is one JSON value; progress and the estimate go to stderr.

## 5. Work items

1. **Run a model from the shared folder** — `src/embeddings/`: the model list (E5), download into the shared
   folder with sha256 (reusing `install`), the runtime loaded from there (E4), tokenizer, one function
   `embed(texts) → Float32Array[]`. Proved on Node and Bun in CI with a tiny test model; `models text
   list|download`.
2. **Version 14 and the chunks** — the migration (E8), `conversation_chunks` written by
   `replaceConversations`, the chunk cutter (E1) as a pure function with tests.
3. **`conversations embed`** — the batches and resume (E6), the status, `--clear`, `store check` counting
   vectors no chunk points at.
4. **`conversations search`** — the scan (E3, E7), output and `--json`, MCP `conversations_search`, the
   in-memory copy in `serve` and `mcp`.
5. **Docs, changelog, parity rows, skill line** — ARCHITECTURE's store section (the two tables, why vectors
   are keyed by hash), `docs/commands.md`, one line in the shared skills; tg-cli and max-cli bump.
6. **Hybrid** (E9), after phase 2 item 6 — RRF over the two lists; the IRC bench's queries cannot score it,
   so a small hand-written query set over a synthetic chat.
7. **Measure** — `bench/embeddings/`: embed time and search time on the `bench/search` corpus at 100k
   messages through the real commands, Node and Bun, recorded in its README.

## 6. Test plan

- **Chunks**: a long conversation cut at message boundaries, never above `CHUNK_TOKENS` unless one message
  is; a rebuild with no text change keeps every hash; an edited message changes only its chunk's hash.
- **Embed**: resumes after a stop; a second run embeds nothing; `--clear` drops only that chat's (and
  model's) vectors; a chat with no built conversations is refused with what to run first.
- **Search**: the nearest chunk first on a fixture of hand-made vectors (no model in unit tests); scope by
  chat and time; a chat embedded with another model is named on stderr.
- **Models**: a file with the wrong sha256 is refused and nothing is installed; Node and Bun load the same
  tiny model and give the same vector within 1e-5.
- **Privacy**: no message text in logs, `store check`, or errors; chunk text is never stored, only its hash.
- **Machine mode**: stdout one JSON value; progress on stderr.
- **One-shot**: the process exits after `embed` and `search` — the WASM runtime's worker threads closed.

## 7. Questions for the owner

1. **NEED-517 · Which model does `conversations embed` use by default?**
   - Now: no model is chosen. Granite 97M is open (Apache-2.0), 123 MB and ~10 chunks a second, but found
     the right passage in 5 of 10 chat-sized chunks. EmbeddingGemma 4-bit found 10 of 10, is 217 MB, runs
     ~1.5 chunks a second (a 100,000-message chat: ~7 hours against ~1), and comes under Google's Gemma
     terms, which pass use restrictions on to users and let Google restrict use.
   - Options: **A** Granite by default, Gemma in the list for whoever accepts its terms · **B** Gemma by
     default · **C** Granite only.
   - Recommended: **A** — an open model by default, the better one a `--model` away, and the list is what
     the owner asked for.
2. **NEED-518 · Keep vectors in a plain table instead of sqlite-vec?**
   - Now: NEED-374 A ruled "SQLite FTS5, sqlite-vec when phase 5 comes". Measured: a plain table scanned in
     JS is as fast as sqlite-vec up to 1M vectors, works on every runtime the store runs on, and needs no
     extension; sqlite-vec is pre-v1 and needs our own build on musl.
   - Options: **A** plain table now, sqlite-vec only if a real archive outgrows it · **B** sqlite-vec now.
   - Recommended: **A**.
