# Storage and search

The move of the message store to Drizzle with an async API, and a local search subsystem over
millions of messages. Start with [`HANDOFF.md`](HANDOFF.md).

| File | Answers |
|---|---|
| [`HANDOFF.md`](HANDOFF.md) | building phase 1: where to start, what to read, what bites |
| [`requirements.md`](requirements.md) | what the owner asked for, verbatim |
| [`decisions.md`](decisions.md) | what is ruled, what is open, what is recommended |
| [`current-state.md`](current-state.md) | the two stores today, who opens them, the servers that exist |
| [`daemon.md`](daemon.md) | whether a daemon is needed, and which kind — trade-offs |
| [`search-indexes.md`](search-indexes.md) | how each search index works, with measured scenarios |
| [`plans/phase-1.md`](plans/phase-1.md) | phase 1: Drizzle, the async store, the §4–§5 schema, `db` commands — approved 2026-09-30 |
| [`research/2026-09-29-search-benchmark.md`](research/2026-09-29-search-benchmark.md) | SQLite FTS5 vs PGlite vs Postgres at 100k and 1M |
| [`research/2026-09-29-pglite-measured.md`](research/2026-09-29-pglite-measured.md) | PGlite 0.5.8, pgvector, pglite-socket, measured |
| [`research/2026-09-29-pglite-web-check.md`](research/2026-09-29-pglite-web-check.md) | the PGlite findings against its docs, issues and source |
| [`research/2026-09-29-drizzle.md`](research/2026-09-29-drizzle.md) | what Drizzle can and cannot do for these stores |
| [`../../bench/search/`](../../bench/search/) | the benchmark fixture and its full results |
