# Phase 5 — search by meaning over a chat's conversations

Plan, 2026-10-02. **Draft; the owner answered §7 on 2026-10-02 (NEED-517 A, NEED-518 A, NEED-519 A) and asked for an external API and parallel embedding, which §4 now plans (E11, E12); nothing is built.** It follows [`../decisions.md`](../decisions.md):
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

By default nothing leaves the machine: no API key, no network except the one-time model download. With
the user's own key, an external model is used instead, asked for each run (E11).

## 2. Depends on

- **Phase 3–4 merged and released** — conversations and agent links ([`phase-3.md`](phase-3.md),
  [`phase-4.md`](phase-4.md)): a chunk is cut from a conversation of the current build.
- **Phase 2's search service** ([`phase-2.md`](phase-2.md) item 6) for the hybrid ranking only (item 6
  below). Everything before item 6 works without it. Phase 2's files (`src/store/sqlite/search*`,
  `words.ts`, `src/search/`) are not edited here.
- **Store version 14**, taken in [the lanes plan](../../plans/2026-09-29-parity-lanes.md) on 2026-10-02 (E8).

## 3. What we know

Measured 2026-10-01/02 on the laptop the speech models were measured on (Ryzen AI 9 HX 470, 12 cores),
Node 24.19 and Bun 1.3.14, with synthetic data only. Full numbers, errors, scripts and raw results:
[`../research/2026-10-02-embeddings.md`](../research/2026-10-02-embeddings.md) and
[`../research/2026-10-02-vectors.md`](../research/2026-10-02-vectors.md).

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
restrict use ([terms](https://ai.google.dev/gemma/terms)). Each number is one run, ±20%, and ten queries
cannot tell 5 from 7: the top-1 column rules out MiniLM and little else.

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
~10 chunks a second that chat embeds in at most about an hour; at Gemma's ~1.5, at most about seven. Both
are upper bounds: the speed was measured on 300-token chunks, and most of those conversations are one or
two short messages. A 5,000-message group takes minutes with either.

## 4. Decisions made here

**E1 · A chunk is a conversation, or a run of its messages.** The current build's conversations of an
embedded chat, in order; a conversation longer than `CHUNK_TOKENS` (300, the measured size) is cut at
message boundaries into consecutive pieces. **Correction 2026-10-02, at build:** the limit is
`CHUNK_CHARS` = 1,200 characters, not tokens, so a chunk is the same whichever model embeds it; e5's
tokenizer reads 3.7 characters a token in Russian and 4.0 in English, so 1,200 is about 300 tokens. The chunk's text is one line per message, `sender: text`,
which the model sees and nothing else. One-message conversations are chunks too: search has to find them.

**E2 · Vectors are keyed by what they encode, not by the conversation.** A rebuild writes new
conversation rows (`conversations.build`, `src/store/sqlite/schema.ts:339`), so a vector tied to a
conversation row would be thrown away by every rebuild. Instead:

- `conversation_chunks (conversation_pk, ordinal, first_message_pk, last_message_pk, content_hash)` —
  derived per build, cascading with the conversation, written by `replaceConversations` with the rest of
  the build;
- `chunk_vectors (model, content_hash, dims, vector BLOB, created_at)`, primary key `(model,
  content_hash)` — the hash is sha256 of the chunk text and the model's input prefix. **Correction 2026-10-02, at
build:** of the chunk text only; the model is already in the key, and its prefix is added when it embeds.

A rebuild that leaves a conversation's text alone leaves its hash alone, and the vector is reused.
This replaces requirements §18's `conversation_embeddings(conversation_id, …)` and keeps its reasons:
several models side by side, rebuildable, droppable without touching `messages`. `store check` counts vectors no chunk points at;
`conversations embed --clear` drops them.

**E3 · Vectors in a plain table, scanned in JS** — no extension (**NEED-518 A**, 2026-10-02). Float32, normalised at
write so a dot product is the cosine. A search reads the scope's vectors in one statement and keeps the
top `--limit`; `serve` and `mcp` keep what they read in memory between queries. sqlite-vec's ruled role
(NEED-374 A) is not needed at the sizes measured, and it would add an extension per platform that official
Node and Bun on Linux load from outside our SQLite. int8 storage and sqlite-vec stay open for when a real
archive passes ~100k chunks.

**E4 · Where the runtime comes from** — **our own package** (**NEED-519 A**, 2026-10-02). `onnxruntime-web` as a dependency adds 145 MB to every
tg and max install, used or not, of which a run opens about 15 MB — what the owner asked to avoid
(NEED-412). Downloading those 15 MB into `~/.cache/cli-common/models/` with the model would avoid it, but
they are JavaScript, not data: the process that holds the owner's session would `import()` code from a
folder any program of the user can write to, and an installed model is checked today by **size only**
(`isInstalled`, `src/speech/install.ts:52`), not by its sha256. Three ways:

- **A** a small package of our own, `@leemour/cli-messaging-onnx`, holding only the three runtime files
  (~15 MB, as `sherpa-onnx`), published like `@leemour/cli-messaging-sqlite` (`packages/sqlite`); nothing
  is imported from the cache, only the model weights (data) come from there;
- **B** download the runtime with the model and check its sha256 on every load before `import()` (~15 MB
  hashed, tens of ms); simplest, but code still comes from a writable folder;
- **C** `onnxruntime-web` as a plain dependency: 145 MB in every install.

`@huggingface/tokenizers` (0.4 MB, pure JS) is a plain dependency in all three.

**E5 · Models: a short list, like speech.** `src/embeddings/models.ts` lists them, most suitable first, each
with its input prefixes (Gemma's `task: search result | query: `, e5's `query: ` and `passage: `), its
token limit and its files. The default is **e5-small**, Gemma in the list for whoever accepts its terms (**NEED-517 A**, 2026-10-02). Threads: see E12. Granite's model card is read for a prefix before it is listed; the
measurement used none.

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
plan first. **Addition 2026-10-02 (owner, NEED-521 A):** the same migration rebuilds `messages_fts` so the
substring index ignores accents, and the substring query is normalized to match
([ruling](../decisions.md#ruled)). It touches phase 2's substring step in `src/store/`, which this
plan otherwise leaves alone; on a large store the rebuild is
probably too slow for one step, and likely needs batches like version 12's word index (not measured).

**E9 · Hybrid ranking is the last item.** When phase 2's service exists, `conversations search` also runs
the word search in the same scope, maps its hits to their conversations, and merges the two lists by
reciprocal rank fusion (requirements §21; k = 60, the usual constant, until the item 6 set says otherwise). Until then the command ranks by meaning only and says
so in its help. `messages search` itself is not changed here.

**E10 · Permissions and machine mode.** `conversations embed` writes only to the local store — the key
`conversations.embed`, so a profile read-only on messages can still embed, as phase 4's
`conversations.links`; `conversations search` shows message text and is checked as `messages`. In machine
mode stdout is one JSON value; progress and the estimate go to stderr.

**E11 · An external model with the user's own key** (owner, 2026-10-02 — amends NEED-412 A; local stays
the default). Facts: [`../research/2026-10-02-embedding-apis.md`](../research/2026-10-02-embedding-apis.md).

- **Providers.** `openai` first, as the owner suggested: `text-embedding-3-small` by default (1536 dims,
  $0.02 per 1M tokens, 2,048 inputs and 300k tokens a request, no training on API inputs by default).
  The same client takes `--base-url`, which covers what serves OpenAI's request shape — Gemini's
  compatibility URL, Jina, Ollama and LM Studio on this machine. Providers whose own API carries a
  query/document input type or names the size field differently (Voyage, Cohere, Gemini's native API)
  get a small adapter each, later, when someone asks; none is built in this phase.
- **The key** is kept as bot tokens are (`BotTokenStore`, `src/cli/bot/token.ts:22`, through cli-core's
  `Credentials`): the keyring account `embeddings:<provider>`, then `<PREFIX>_OPENAI_API_KEY` or
  `OPENAI_API_KEY`, then a 0600 file. `models text key set <provider>` reads it from a hidden prompt or
  stdin, never from an argument; `models text key remove`. The key is never printed, logged or echoed in
  an error.
- **The text leaves the machine, so it is asked for each time.** `conversations embed --chat <chat>
  --provider openai [--model <m>] [--base-url <url>]` prints, before sending anything: the chat, the
  provider and model, the number of chunks and tokens, the price per 1M tokens from the model list with
  the date it was read, and that the messages go to that provider. Interactive: it waits for a yes. Machine
  mode: it refuses without `--yes`. `--max-tokens <n>` stops before a run above it (requirements §15's cost
  limit). Every run asks again; a yes for one chat is not a yes for another. A `--base-url` on this machine
  (`localhost`, `127.0.0.1`, `::1`) sends nothing out and asks nothing.
- **Vectors from different models never mix** (both research files): `chunk_vectors.model` is
  `<provider>:<model>:<dims>`, so `openai:text-embedding-3-small:1536` and the local e5 live side by side,
  and a search uses one of them — `--model`, else the model the chat was embedded with most.
- **Errors** name the HTTP status and the provider's error code, never the request body. 429 waits for
  `Retry-After` and continues; 401 stops and says to set the key again.

**E12 · Parallel embedding** (owner, 2026-10-02). Measured in
[`../research/2026-10-02-embeddings.md`](../research/2026-10-02-embeddings.md#running-in-parallel):

- **Local, by default: one session on `min(8, cores)` threads**, set explicitly (Bun otherwise takes 1):
  ~1.45× the 4-thread speed for ~60 MB more. More threads gain nothing.
- **`--workers <n>`** runs n sessions in `node:worker_threads`, each with its own copy of the model, the
  threads split between them: 3 workers ~1.8×, 6 ~2.0× on this 12-core laptop, at ~0.6 GB a worker. The
  command prints the memory it will take and refuses a count whose sessions would not fit in the free
  memory (`os.freemem()`), so it never pushes the machine into swap. The main thread tokenizes and writes;
  workers only run the model; one transaction per batch of results, as E6.
- **External: requests in parallel.** `--concurrency <n>` (default 4) requests at once, each up to the
  provider's limits — for OpenAI 2,048 inputs and 300k tokens a request; a 429 slows every request down to
  its `Retry-After`. Results are written in the order they come back; a chunk is either written or asked
  again on the next run (E6's resume).

## 5. Work items

1. ✅ 2026-10-02: the runtime package (cli-messaging #381, `@leemour/cli-messaging-onnx` 1.0.0 on npm), `src/embeddings/` and `models text list|download`; threads per E12, `--workers` with item 3 · **Run a model from the shared folder** — `src/embeddings/`: the model list (E5), download into the shared
   folder with sha256 (reusing `install`), the runtime from `@leemour/cli-messaging-onnx`, a new `packages/onnx` published like `packages/sqlite` (E4), tokenizer, one function
   `embed(texts) → Float32Array[]`. Proved on Node and Bun in CI with a tiny test model; `models text
   list|download`.
2. ✅ 2026-10-02 · **Version 14 and the chunks** — the migration (E8), `conversation_chunks` written by
   `replaceConversations`, the chunk cutter (E1) as a pure function with tests.
3. ✅ 2026-10-02 · **`conversations embed`** — threads and `--workers` (E12), the `conversations.embed` key in `keyForCommand` (`src/sends/permissions.ts`,
   beside phase 4's `conversations.links`; without it the path is checked as `messages`), the batches and
   resume (E6), the status, `--clear`, `store check` counting
   vectors no chunk points at.
4. **The external provider** (E11, E12) — `openai` with `--base-url`, the key commands, the consent
   step and `--max-tokens`, `--concurrency`, retries; tested against a stand-in server, never a real key.
5. **`conversations search`** — the scan (E3, E7), output and `--json`, MCP `conversations_search`, the
   in-memory copy in `serve` and `mcp`.
6. **Docs, changelog, parity rows, skill line** — ARCHITECTURE's store section (the two tables, why vectors
   are keyed by hash), `docs/commands.md`, one line in the shared skills; tg-cli and max-cli bump.
7. **Hybrid** (E9), after phase 2 item 6 — RRF over the two lists; the IRC bench's queries cannot score it,
   so a small hand-written query set over a synthetic chat.
8. **Measure** — `bench/embeddings/` (today the research scripts of §3): embed time and search time on the `bench/search` corpus at 100k
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

Answered 2026-10-02: **1 A, 2 A, 3 A** («1 A 2 A 3 A»). Kept below as asked.

1. **NEED-517 · Which model does `conversations embed` use by default?**
   - Now: no model is chosen. All three candidates run on this machine, under Node and Bun:
     Granite 97M (Apache-2.0, 123 MB, ~10 chunks a second), e5-small (MIT, 135 MB, ~10 a second) and
     EmbeddingGemma 4-bit (217 MB, ~1.5 a second, Google's Gemma terms: use restrictions passed on to
     users, Google may restrict use). On chat-sized chunks they found the right passage 5, 7 and 10 times
     of 10 — ten queries, so Granite against e5 is a tie and Gemma's lead is the only clear one. A
     100,000-message chat takes at most about an hour with Granite or e5, at most about seven with Gemma.
   - Options: **A** e5-small by default, Gemma in the list for whoever accepts its terms · **B** Granite by
     default, Gemma in the list · **C** Gemma by default.
   - I'd pick: **A** — open, fast, and the better of the two open models on chunks; Gemma a `--model` away.
     e5's ONNX copy (Xenova) states no licence of its own; the model it converts is MIT.
   - If you don't answer: the plan builds with A, and the default is one line in `src/embeddings/models.ts`.
2. **NEED-518 · Keep vectors in a plain table instead of sqlite-vec?**
   - Now: NEED-374 A ruled "SQLite FTS5, sqlite-vec when phase 5 comes". Measured: a plain table scanned in
     JS is as fast as sqlite-vec up to 1M vectors, works on every runtime the store runs on, and needs no
     extension; sqlite-vec is pre-v1 and needs our own build on Alpine Linux.
   - Options: **A** plain table now, sqlite-vec only if a real archive outgrows it · **B** sqlite-vec now.
   - I'd pick: **A** — same speed, no extension to ship per platform.
   - If you don't answer: item 2 waits; the table's shape depends on it.
3. **NEED-519 · Where does the model runtime come from?** (E4)
   - Now: the runtime that runs the models is 145 MB as an npm dependency, of which 15 MB is used. Putting
     those 15 MB in the shared models folder means running code from a folder any program can change.
   - Options: **A** our own small package with the 15 MB · **B** downloaded with the model, its sha256
     checked before every load · **C** the 145 MB dependency.
   - I'd pick: **A** — the install stays small and no code is loaded from the cache; one more package to
     publish, as `packages/sqlite` already is.
   - If you don't answer: item 1 waits; it is the first thing built.
