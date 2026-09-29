# Storage and search

The move of the message store to Drizzle with an async API, and a local search subsystem over
millions of messages. Start with [`HANDOFF.md`](HANDOFF.md).

| File | Answers |
|---|---|
| [`HANDOFF.md`](HANDOFF.md) | where to start, what to read, what bites |
| [`requirements.md`](requirements.md) | what the owner asked for, verbatim |
| [`decisions.md`](decisions.md) | what is ruled, what is open, what is recommended |
| [`current-state.md`](current-state.md) | the two stores today, who opens them, the servers that exist |
| [`daemon.md`](daemon.md) | whether a daemon is needed, and which kind — trade-offs |
| [`research/2026-09-29-search-benchmark.md`](research/2026-09-29-search-benchmark.md) | SQLite FTS5 vs PGlite vs Postgres at 100k and 1M |
| [`research/2026-09-29-pglite-measured.md`](research/2026-09-29-pglite-measured.md) | PGlite 0.5.8, pgvector, pglite-socket, measured |
| [`research/2026-09-29-pglite-web-check.md`](research/2026-09-29-pglite-web-check.md) | the PGlite findings against its docs, issues and source |
| [`research/2026-09-29-drizzle.md`](research/2026-09-29-drizzle.md) | what Drizzle can and cannot do for these stores |
| [`../../bench/search/`](../../bench/search/) | the benchmark fixture and its full results |
