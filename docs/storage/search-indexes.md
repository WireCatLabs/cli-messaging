# How search works — the indexes, search by meaning, and what each one is for

**Current status, 2026-10-04:** strict Lucene message search and optional graph/embedding conversation search are implemented. **Correction:** the automatic typo/any-word/substring pipeline described in the index-design sections belongs to explicit `--language legacy`, not the current default. The [query-language guide](../search/query-language.md) and [technical specification](../search/query-language-spec.md) define strict syntax, validation, limits and coverage. The semantic-search sections describe the existing separate conversation path. No live account or archive was used for this correction; source inspected at `680d22e`.

## Two searches

| | `messages search` | `conversations search` |
|---|---|---|
| finds | messages | conversations inside a group chat |
| by | strict Lucene words/phrases, Boolean fields and bounded patterns; legacy discovery only when selected | meaning, and the words it shares, merged |
| needs | stored history and a ready word index for strict text predicates | `conversations build`, then `conversations embed` |
| runs | SQLite plus bounded validation/pattern checks; no embedding model | a model on this machine (or the user's API key), then a scan |
| MCP tool | `<cli>_messages_search` | `<cli>_conversations_search` |

`messages search` answers "where did someone say X". `conversations search` answers "where did we talk
about X" when nobody used the same words: a question in your own words finds the conversation that
answers it, in the language it was held in.

```text
messages search "gestor valencia"
  parse/validate/scope ─▶ SQLite word/metadata predicates ─▶ strict matching messages

messages search "gestor valencia" --language legacy
  words ─▶ nothing? correct typos ─▶ nothing? any word ─▶ nothing? substring

conversations search "кто искал квартиру"
  the model turns the query into a vector ─▶ scan the chunks' vectors ─▶ conversations by meaning ─┐
  the query's words, joined by OR ─▶ messages search (whole words only) ─▶ their conversations ───┤
                                                                     reciprocal rank fusion ◀──────┘
                                                                     ▼
                                                            conversations, best first
```

## The five kinds of index

1. **Filter indexes** — ordinary B-tree indexes: by chat and time, by sender, by account. They make
   `--chat`, `--from`, `--after`, `--before` fast. Always there.
2. **The word index, ranked by BM25** — FTS5 with the `unicode61` tokenizer over `normalized_text`,
   with a prefix index.
3. **The vocabulary** — FTS5 terms for bounded strict wildcard/regex expansion; legacy discovery additionally keeps term/trigram tables for typo candidates.
4. **The substring index** — FTS5 with the `trigram` tokenizer over message text: any three letters
   anywhere. It exists today (migration 5).
5. **Name indexes** — small trigram indexes over chat titles and over people's names and usernames.
   Not over messages.

## 2 · The word index

It works like the index at the back of a book. Each message is normalized — lowercase, accents
removed, ё turned into е — then split into words at spaces and punctuation, and for every word the
index keeps the list of messages that contain it:

```text
gestor    → message 1
valencia  → message 1
tie       → message 4
ptsarev   → message 5      (calendly.com/ptsarev splits into calendly, com, ptsarev)
99812     → message 2      (ab-99812 splits into ab, 99812)
ab45217   → message 2      (no separator: one word)
```

A search for «gestor valencia» looks both lists up and keeps the messages in both. Legacy discovery also tries word beginnings. Strict Lucene needs an explicit wildcard such as `квартир*` for that behavior; a bare term is not silently expanded.

**BM25** orders what was found. For each message it adds up, per search word:

- **how rare the word is** across all messages — «ptsarev» is in few, «en» in almost all, so a match
  on «ptsarev» counts far more;
- **how often the word occurs in this message**;
- **how short the message is** — a short message with the word ranks above a long one where it is
  lost.

No embedding model is needed for this index. [Historical index benchmarks](research/2026-09-29-search-benchmark.md) measure particular query/storage paths, not a universal end-to-end strict-search latency guarantee.

## 3 · The legacy typo vocabulary

A table of every distinct word in the messages — 38 for the six messages below, 143,501 at 100k
messages (measured). Each word also has its three-letter pieces, indexed, so a typo can be looked up
fast:

```text
valencia → val ale len enc nci cia
whatsapp → wha hat ats tsa sap app
```

A search for «Valenca»:

1. Is «valenca» in the vocabulary? No.
2. Its pieces are `val ale len enc nca`. Which known words share several? valencia (4 shared), and
   others.
3. Keep those at most 2 edits away (an edit adds, removes, changes or swaps one letter). valencia is 1.
4. Search the word index for «valencia».

The vocabulary never searches messages itself; it only turns a typo into a real word.

## 4 · The substring index

It keeps every three-letter piece of every message, so it finds any three or more letters anywhere,
including inside a word. It cannot find fewer than three letters, and ranking over letter pieces is
weak.

## 5 · Name indexes

Answer "which chat or person did you mean": `--chat expats` finds «Valencia Expats», `--from ptsa`
finds «@ptsarev_v»; `contacts search` uses them. Small, and they exist today.

## Scenarios — measured

Run on 2026-09-30 in `node:sqlite` (Node 24) with both FTS5 tokenizers over six messages:

1. «¿Alguien conoce un buen gestor en València?»
2. «Order AB45217 arrived, tracking ab-99812»
3. «Сдаю квартиру в центре, пишите в whatsapp»
4. «Tiempo de espera para la TIE: dos meses»
5. «My calendly.com/ptsarev link for the TV setup»
6. «Entiendo, gracias»

| Search | Word index (2) | Substring index (4) | Who finds it |
|---|---|---|---|
| gestor valencia | 1 | 1 | both; words rank better |
| Valenca (typo) | — | — | **neither — only the vocabulary (3)** corrects it to valencia |
| whatsap (a letter missing) | — | 3 | **substring**; the vocabulary corrects it too |
| квартир (start of a word) | 3 | 3 | both |
| len (middle of a word) | — | 1, 5 (valencia, calendly) | **substring**, with noise |
| 45217 (inside «AB45217») | — | 2 | **substring** |
| 99812 (after a hyphen) | 2 | 2 | both |
| sarev (part of «ptsarev») | — | 5 | **substring** |
| tie | 4 | 4, **6** («en**tie**ndo») | **words**; substring adds noise |
| tv (two letters) | 5 | — | **words**; substring needs three letters |

So: **words with BM25** rank best, bring no noise and handle short words; **the vocabulary** fixes
typos neither index finds alone; **substring** finds fragments — parts of numbers, links, names, the
middle of words — and brings noise.

## Explicit legacy discovery order

1. Word index, every word required, ranked by BM25.
2. Nothing found → correct unknown words through the vocabulary, search again.
3. Still nothing → any word instead of every word (NEED-375).
4. Still nothing → the substring index.

This sequence runs only in legacy discovery. Strict Lucene preserves the requested Boolean set, emits no automatic corrections, and errors when its word index is not ready or an execution budget is exceeded. Filters (chat, sender, source, date) apply at every legacy step in the database.

**Correction 2026-10-02** — as built in `src/search/search.ts`: step 1 also takes word beginnings
(«квартир» finds квартиру), each step runs only when the one before found nothing, and until the word
index is fully built a search uses the substring index alone. The index fills itself in batches —
from `store migrate`, `store reindex`, and up to 200 ms before each `messages search`. `in:` and
`--source` widen the search to other accounts the store holds (`in:personal`, `in:bots`, `in:all`).
Every hit says which step found it (`match`: `words`, `beginnings`, `corrected`, `anyWord`,
`substring`), and `corrections` lists the words that were replaced.

## Search by meaning

Phase 5. Four steps, each a command the owner runs, and nothing leaves the machine unless asked.

### 1 · Conversations, then chunks

`conversations build --chat <chat>` groups a group chat's messages into conversations — by replies,
mentions and who wrote next ([phase 3](plans/phase-3.md)). The same build cuts each conversation into
**chunks**: consecutive messages, cut only between messages, at most 1,200 characters each (about 300
tokens; `CHUNK_CHARS`, `src/conversations/chunks.ts`). A chunk's text is `sender: text` per line. The
text is never stored — only the chunk's first and last message and the sha256 of its text
(`conversation_chunks`).

Why chunks and not whole conversations: e5-small reads at most 512 tokens (EmbeddingGemma 2,048), and
one long conversation covers many subjects. Why not single messages: «ок» or «да, давай» mean nothing alone.

### 2 · Vectors

`conversations embed --chat <chat>` gives every chunk of the current build a **vector** — 384 numbers
for e5-small — that places texts of similar meaning near each other. Vectors live in `chunk_vectors`,
keyed by **model and text hash**, not by chat or conversation:

- a rebuild writes new conversation rows, but a chunk whose text did not change has the same hash and
  finds its vector again — nothing is embedded twice;
- the same text in two chats has one vector;
- two models never mix — e5-small, EmbeddingGemma and an API model each keep their own.

The run resumes where it stopped, and `embed status` says how many chunks are left and how long they
should take. A chunk whose messages changed after the build waits for the next build.

**The models** (`models text list`, downloaded once into a folder every messenger CLI shares):

| model | vector | size | languages | speed here |
|---|---|---|---|---|
| **e5-small** (default) | 384 | ~135 MB | ~100, Russian and English among them | ~31 chunks/s |
| EmbeddingGemma | 768 | ~220 MB | 100+, better on chat | about 7× slower |
| an API: OpenAI `text-embedding-3-small`, or any server with OpenAI's `/v1/embeddings` (`--base-url`) | the model's | — | the model's | the API's |

They run in our own WebAssembly build of ONNX Runtime (`@leemour/cli-messaging-onnx`) — no native
code, the same on Node and Bun. An API model needs the user's key (`models text key set`), says
how many chunks, tokens and dollars at most before chat text leaves the machine, and waits for a yes.

e5-small is weak across languages: an English chat did not answer the same question asked in Russian.
EmbeddingGemma does better.

### 3 · The scan

`conversations search "<query>"` turns the query into a vector with the same model, then reads every
vector of the chats in scope and keeps each conversation's best chunk by **cosine** — how close two
vectors point, from −1 to 1; vectors are stored at length one, so it is a plain dot product. No
vector index: SQLite reads 5,000 rows at a time in the chunks' key order, and JavaScript does the
arithmetic (`nearestChunks`, `src/store/sqlite/vectors.ts`). At the sizes measured a plain table was as
fast as sqlite-vec, which would need a native extension per platform
([research](research/2026-10-02-vectors.md)).

A chat embedded only with another model cannot be searched by meaning with this one: the search names
it on stderr and in `embeddedOnlyElsewhere`, instead of leaving it out silently.

### 4 · Meaning and words, merged

Meaning misses a rare exact word — a name, a reference number, «empadronamiento» — and words miss a
paraphrase. So the same command also runs `messages search` over the query's plain words, joined by
`OR` (nothing in the original question is read as a filter), and maps matching messages to their conversations. Under the current strict default these are whole-word matches; automatic prefix/typo/substring discovery is not added to the word branch. The two lists merge by **reciprocal rank fusion**: a conversation scores
1 / (60 + its rank) in each list it is in, and the sum orders the result. At least 50 semantic candidates (or the requested limit when larger) and the conversations of up to 200 word-matched messages take part.

Each result says how it was found:

```json
{ "summary": { "id": "656", "firstMessageId": "1640", "messageCount": 7, "…": "…" },
  "chunk": { "firstMessageId": "1640", "lastMessageId": "1707" },
  "score": 0.835,
  "by": ["meaning", "words"] }
```

`score` is the meaning's cosine, `null` when only words found the conversation. A built chat that was
never embedded can still be found by its words, but the current command still opens the selected model to encode the query; the model must be installed/configured.

### In the MCP server

A one-shot command loads the model (~1 s), searches and exits. The MCP server keeps the model between
calls (`warmEmbedders`, `src/embeddings/embed.ts`), so a search after the first pays only the scan.
~~On Node the kept model runs in a worker thread of its own and is closed after 10 minutes without a
search; the next search loads it again. On Bun it stays loaded.~~ **Correction 2026-10-02:** the kept
model runs in a child process of its own, on Node and Bun alike, and the process ends after 10 minutes
without a search; the next search starts it again (~1 s). The server itself stays near its starting size.

| measured 2026-10-02, three load-and-close cycles | memory left after each close |
|---|---|
| the model in a child process (what runs) | none — the server stays at 52–64 MB, Node and Bun |
| Node, the model in a worker thread | ~0.2 GB each time, from ~1 GB loaded |
| Node, the model in the same thread | ~0.8 GB — closing the session alone frees ~0.1 GB |
| Bun, a worker thread or the same thread | grows 0.2–0.55 GB a cycle |

A request travels as one line of JSON each way (`src/embeddings/process.ts`, `child.ts`); a warm query
takes 7–14 ms of it. A child whose server is killed sees its input close and exits.

Vectors are not kept in memory: `embed` and `build` run in other processes, and a copy in the server
would go stale.

### Measured at 100k messages

One group chat of 100,000 synthetic messages in three languages, 42,417 chunks, a 24-thread laptop
([bench/embeddings](../../bench/embeddings/README.md)):

| step | time |
|---|---|
| `conversations build` | 3.3 s |
| `conversations embed`, e5-small | ~22 min, Node or Bun; 3 workers gain 1.04–1.1× |
| `conversations search`, one-shot | ~1.4 s (model load ~1 s, then the scan) |
| `conversations search` in the MCP server | ~0.35 s |
| of which the word search | ~25 ms |

Before the scan read the chunks in their key order, SQLite sorted every vector for each 5,000-row page,
and the MCP search took 1.4 s.

### Where it lives

| what | where |
|---|---|
| cutting chunks, their text and hash | `src/conversations/chunks.ts` |
| the model list | `src/embeddings/models.ts` |
| running a model: in this thread, in workers, kept warm in a child process | `src/embeddings/embed.ts`, `pool.ts`, `workers.ts`, `process.ts`, `child.ts` |
| download, with sha256, into the shared folder | `src/cli/messenger/models-command.ts`, through `src/speech/install.ts` |
| an API model | `src/embeddings/remote.ts` |
| embed, status, clear, search, the merge | `src/services/embeddings.ts` |
| the vector tables and the scan | `src/store/sqlite/vectors.ts` |
| the commands | `src/cli/messenger/conversations-command.ts` |
| the MCP tool | `src/mcp/tools/conversations.ts` |

