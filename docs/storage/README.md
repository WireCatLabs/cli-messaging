# Storage and search

The move of the message store to Drizzle with an async API, and a local search subsystem over
millions of messages. Start with [`HANDOFF.md`](HANDOFF.md).

| File | Answers |
|---|---|
| [`HANDOFF.md`](HANDOFF.md) | building phase 1: where to start, what to read, what bites |
| [`requirements.md`](requirements.md) | what the owner asked for, verbatim |
| [`decisions.md`](decisions.md) | what is ruled, what is open, what is recommended |
| [`current-state.md`](current-state.md) | the two stores today, who opens them, the servers that exist. **Correction 2026-09-30:** a snapshot of 0.27.0; today's store is in [ARCHITECTURE](../dev/ARCHITECTURE.md#the-store) |
| [`daemon.md`](daemon.md) | whether a daemon is needed, and which kind — trade-offs |
| [`search-indexes.md`](search-indexes.md) | how search works: the word indexes with measured scenarios, and search by meaning — chunks, vectors, the scan, the merge with words, the MCP server's model, measured at 100k |
| [`plans/phase-1.md`](plans/phase-1.md) | phase 1: Drizzle, the async store, the §4–§5 schema, `db` commands — approved 2026-09-30 |
| [`plans/phase-3.md`](plans/phase-3.md) | phase 3: conversations inside a group chat — links with their source, one parent per message, scoring on the IRC corpus — approved 2026-09-30 |
| [`plans/phase-5.md`](plans/phase-5.md) | phase 5: search by meaning — chunks of conversations, local embeddings, a plain vector table — draft 2026-10-02 |
| [`research/2026-10-02-embedding-apis.md`](research/2026-10-02-embedding-apis.md) | hosted embedding APIs (OpenAI, Gemini, Cohere, Voyage, Mistral, Jina): limits, prices, data use, request shape |
| [`research/2026-10-02-embeddings.md`](research/2026-10-02-embeddings.md) | local embedding models under Node and Bun with no native code: runtime, size, speed, a quality sanity check |
| [`research/2026-10-02-vectors.md`](research/2026-10-02-vectors.md) | vectors in SQLite: sqlite-vec on each runtime against a plain table scanned in JS, 10k–1M |
| [`research/2026-09-30-disentanglement.md`](research/2026-09-30-disentanglement.md) | separating interleaved conversations: datasets, features, LLM results, metrics |
| [`research/2026-09-30-archive-reliability.md`](research/2026-09-30-archive-reliability.md) | how tg-archive and Telegram-Archive keep an archive complete, against our store |
| [`research/2026-09-29-search-benchmark.md`](research/2026-09-29-search-benchmark.md) | SQLite FTS5 vs PGlite vs Postgres at 100k and 1M |
| [`research/2026-09-29-pglite-measured.md`](research/2026-09-29-pglite-measured.md) | PGlite 0.5.8, pgvector, pglite-socket, measured |
| [`research/2026-09-29-pglite-web-check.md`](research/2026-09-29-pglite-web-check.md) | the PGlite findings against its docs, issues and source |
| [`research/2026-09-29-drizzle.md`](research/2026-09-29-drizzle.md) | what Drizzle can and cannot do for these stores |
| [`../../bench/search/`](../../bench/search/) | the benchmark fixture and its full results |

Search AI configuration and opt-in analysis: [`../search/ai-providers.md`](../search/ai-providers.md).
