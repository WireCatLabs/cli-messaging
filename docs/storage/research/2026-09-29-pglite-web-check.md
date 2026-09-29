# PGlite findings checked against outside sources — our setup, or PGlite?

2026-09-29. Each finding of [`2026-09-29-pglite-measured.md`](2026-09-29-pglite-measured.md) checked
against the docs, the issue tracker and PGlite's own source (0.5.8, commit `ae182ff`), and the
insert test re-run with the documented bulk-load path. Verdicts: **CONFIRMED**, **CONTRADICTED**,
**SETUP-DEPENDENT**.

1. **No lock on the data directory — CONFIRMED.** The README says single user, single connection
   ([readme](https://github.com/electric-sql/pglite#readme)); the lock-file request has no maintainer
   reply ([#1106](https://github.com/electric-sql/pglite/issues/1106)); the Node filesystem is an
   Emscripten mount with no lock (`packages/pglite/src/fs/nodefs.ts`); the official multi-client
   answer is the browser-only [multi-tab worker](https://pglite.dev/docs/multi-tab-worker). Also: the
   Node filesystem never really flushes, so an OS crash can lose data
   ([#1107](https://github.com/electric-sql/pglite/issues/1107)).
2. **Slow bulk insert — SETUP-DEPENDENT, gap stays large.** Postgres docs: GIN insertion is slow;
   for bulk loads build the index afterwards with a large `maintenance_work_mem`
   ([GIN tips](https://www.postgresql.org/docs/current/gin.html#GIN-TIPS)). PGlite keeps Postgres
   defaults (`pglite.ts:149-170`) and always runs with fsync off (`-F`, `pglite.ts:151`); on Node the
   sync step is a no-op (`fs/base.ts:62`), so `relaxedDurability` changes nothing. 100k rows, ~12
   Russian/English words each:

   | Load path | Time |
   |---|---|
   | one-row INSERT per query, index first | 14.05 s (our 15.1 s) |
   | batches of 1000 via `unnest`, index first | 4.6 s |
   | batches, index after (256 MB `maintenance_work_mem`) | 0.29 s + 3.2 s index = 3.5 s |
   | COPY, index after | 0.15 s + 2.95 s = 3.1 s |

   Best case ~5× slower than node:sqlite FTS5 (0.65 s), not 23×; the GIN build itself is ~3 s.
   `ILIKE … LIMIT 20` averaged 8 ms. PGlite's own [benchmarks](https://pglite.dev/benchmarks) agree in
   direction (25k inserts: 0.292 s PGlite in memory vs 0.077 s wa-sqlite, browser) and test neither GIN
   nor Node.
3. **~0.25 s reopen, ~540 MB memory — CONFIRMED in direction, no official figures.** `initialMemory`
   is only the starting heap, which grows ([api](https://pglite.dev/docs/api)); the memory issue has no
   answer ([#406](https://github.com/electric-sql/pglite/issues/406)). With `memory://` storage the whole
   database lives in the WebAssembly heap: 1179 MB at 100k rows.
4. **pglite-socket runs one query at a time and can deadlock — CONFIRMED.** Its docs: PGlite "is a
   single-connection database", multiplexed, "not all cases might be covered"
   ([pglite-socket](https://pglite.dev/docs/pglite-socket)); [#985](https://github.com/electric-sql/pglite/issues/985)
   and [#1046](https://github.com/electric-sql/pglite/issues/1046) open.
   [#958](https://github.com/electric-sql/pglite/issues/958) is not a deadlock: a premature
   ReadyForQuery after a failed statement, which breaks Prisma.
5. **A 0.4.x directory does not open in 0.5.x — CONFIRMED.** Minor versions may break the format;
   the path is dump and restore ([upgrade](https://pglite.dev/docs/upgrade), which shows only
   0.3→0.4). Netlify hit it in production and moved the old directory aside
   ([netlify/primitives#792](https://github.com/netlify/primitives/pull/792)).
6. **BM25 in PGlite.** `@electric-sql/pglite-pg_textsearch` 0.0.10 is Timescale's
   [pg_textsearch](https://github.com/timescale/pg_textsearch) v1.3.1 (upstream is at v1.4.0; it calls
   1.3.1 "production ready"); PGlite lists it as "external". One text column per index (expressions can
   combine); tokenization by a Postgres text search config per index (`russian`, `simple`) — mixed
   languages need one partial index per language. **No phrase search** (no positions), **no fuzzy**;
   heavy writes "not yet fully optimized", build after load. No PGlite numbers found; upstream
   [benchmarks](https://timescale.github.io/pg_textsearch/benchmarks/) are native Postgres.
7. **SQLite side** (SQLite 3.53.3 in Node 24, 3.53.0 in Bun 1.3.14). Built in: FTS5, `trigram`
   tokenizer with `remove_diacritics 1`, `fts5vocab`. `spellfix1` is not built in. `bm25()`: lower is
   better, k1 = 1.2 and b = 0.75 fixed ([fts5](https://www.sqlite.org/fts5.html)). `trigram` matches
   substrings, not typos, and nothing under 3 characters. `unicode61 remove_diacritics 2` strips
   accents from Latin only — «елка» does not find «Ёлка», «иод» not «йод»: normalize ё and й before
   indexing. Typo tolerance without extensions: a word list from `fts5vocab`, trigram overlap and edit
   distance in JS; or `loadExtension` with a compiled spellfix1 — `node:sqlite` has `allowExtension`
   since 22.5 and `loadExtension` since 22.13/23.5 ([node sqlite](https://nodejs.org/api/sqlite.html)).
   [sqlite-vec](https://alexgarcia.xyz/sqlite-vec/js.html) works with `node:sqlite` from 23.5, is
   alpha (v0.1.10-alpha.4); Bun on macOS needs `Database.setCustomSQLite`.
8. **Other embedded options.** LanceDB: BM25, edit-distance fuzzy, vectors, TS API — new rows are not
   searchable until `optimize()`, multi-process not documented
   ([fts](https://docs.lancedb.com/search/full-text-search)); excluded by the requirements anyway.
   DuckDB FTS: `match_bm25`, no fuzzy, index not updated on change, one writing process
   ([fts](https://duckdb.org/docs/current/core_extensions/full_text_search.html),
   [concurrency](https://duckdb.org/docs/current/connect/concurrency.html)). libSQL: vector columns
   and `vector_top_k`; local-file index support not stated
   ([docs](https://docs.turso.tech/features/ai-and-embeddings)). **No option found has BM25, fuzzy
   and safe multi-process access together.**
