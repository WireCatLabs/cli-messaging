# PGlite 0.5.8 with pgvector, pglite-socket and Drizzle — measured

2026-09-29, Node 24.19 and Bun 1.3.14, on the owner's Linux machine, in a scratch directory (no
repository touched). **Measured** = run here; **docs say** = a documentation claim; **inferred** =
reasoning. Whether these numbers come from a setup mistake is checked separately in
[`2026-09-29-pglite-web-check.md`](2026-09-29-pglite-web-check.md).

## Versions and extensions

- Latest stable `@electric-sql/pglite` **0.5.8** (2026-08-26), embedding **PostgreSQL 18.3**
  (measured: `select version()`). 0.3.0 moved to PG 17.4; 0.5.0 to PG 18.3 and split extensions
  into their own npm packages ([changelog](https://github.com/electric-sql/pglite/blob/main/packages/pglite/CHANGELOG.md)).
- **pgvector** is `@electric-sql/pglite-pgvector` 0.0.9, peer-pinned to exactly pglite 0.5.8.
  `@electric-sql/pglite/vector` no longer exists.
- Other extension packages (0.0.9–0.0.10, each pinned to pglite 0.5.8): `pg_textsearch` (BM25,
  marked experimental), `pg_uuidv7`, `pg_hashids`, `pg_ivm`, `pgtap`, `age`; `pglite-postgis` 0.2.8.
- Built in, from `@electric-sql/pglite/contrib/<name>`: amcheck, auto_explain, bloom, btree_gin,
  btree_gist, citext, cube, dict_int, dict_xsyn, earthdistance, file_fdw, fuzzystrmatch, hstore,
  intarray, isn, lo, ltree, moddatetime, pageinspect, pg_buffercache, pg_freespacemap,
  pg_stat_statements, pg_surgery, **pg_trgm**, pg_visibility, pg_walinspect, pgcrypto, seg,
  tablefunc, tcn, tsm_system_rows, tsm_system_time, **unaccent**, uuid_ossp.
- Case-insensitive Cyrillic works: `ILIKE '%мир%'` matched «Мир» through the pg_trgm GIN index
  (measured; locale C.UTF-8).

## One process per data directory

- **Two processes on one data directory corrupt it without an error** (measured): a writer and
  two readers ran together; afterwards every open failed with `RuntimeError: Aborted()`.
  `postmaster.pid` exists and is ignored. Open issue:
  [electric-sql/pglite#1106](https://github.com/electric-sql/pglite/issues/1106). A daemon design
  needs **its own lock file** around the directory.
- **`@electric-sql/pglite-socket` 0.2.11** serves the Postgres wire protocol over TCP or a Unix
  socket, plus a `pglite-server` command. Default 1 connection; `maxConnections` enables a
  multiplexer that **runs one message at a time** and pins a transaction to its connection
  (measured, from its source). `pg.Pool` and `drizzle-orm/node-postgres` work against it; with A in a
  transaction, B's query waited ~500 ms until A committed; five parallel `pg_sleep(0.2)` took
  ~1015 ms. Same under Bun. Open bugs: queue deadlock when a client disconnects mid-transaction
  ([#985](https://github.com/electric-sql/pglite/issues/985)); interleaved extended-protocol batches
  deadlock the queue for good ([#1046](https://github.com/electric-sql/pglite/issues/1046));
  ~~premature ReadyForQuery~~ **correction:** not a deadlock — a premature ReadyForQuery after a failed statement ([#958](https://github.com/electric-sql/pglite/issues/958)). Installing it
  pulls every extension package (25 packages). A Unix socket path over ~107 bytes fails `EINVAL`.
- `PGliteWorker` / multi-tab coordinates browser tabs (`BroadcastChannel`, `navigator.locks`), not
  operating-system processes.

## Runtime, speed, size

- No `engines` field. Docs say Node and Bun ([about](https://pglite.dev/docs/about)); Node 24 and
  Bun 1.3 tested, Node 22 not. Open Bun issues: Windows bytea
  ([#782](https://github.com/electric-sql/pglite/issues/782)); an INSERT that never returns with
  pgvector and a GIN index on 0.4.3 ([#1068](https://github.com/electric-sql/pglite/issues/1068)).
- Open: ~1.1 s creating a database, **210–250 ms** reopening, on both runtimes.
- Memory: **~540 MB RSS** in Node with vector, pg_trgm, unaccent loaded; Bun 1.1 GB on create,
  354 MB on reopen.
- Unpacked: pglite 25.4 MB, pglite-socket 347 KB, pglite-pgvector 63 KB, pglite-tools 1.8 MB.
- Empty database with three extensions: 39 MB on disk.
- 100k rows, one transaction:

| | PGlite + pg_trgm GIN | node:sqlite FTS5 trigram |
|---|---|---|
| insert | 15.1 s | 0.65 s |
| selective search | 4 ms | 0.2 ms |
| search matching every row | 142 ms | 26 ms |

**Correction 2026-09-29:** the 15.1 s was one INSERT per row with the GIN index already built.
Loading with COPY and building the index afterwards takes 3.1 s — about 5× SQLite, not 23× (see
[`2026-09-29-pglite-web-check.md`](2026-09-29-pglite-web-check.md) §2). At 1M:
[`2026-09-29-search-benchmark.md`](2026-09-29-search-benchmark.md).

## Drizzle

- drizzle-orm **0.45.3** (stable) exports `./pglite`, `./pglite/migrator`, `./node-postgres`,
  `./sql/functions/vector` (`l2Distance`, `cosineDistance`, `innerProduct`, …) and the vector,
  halfvec, sparsevec, bit column types; pglite peer `>=0.2.0` (measured, tarball).
- Indexes: `index().using("hnsw", t.emb.op("vector_cosine_ops"))`,
  `.using("gin", t.body.op("gin_trgm_ops"))` (docs:
  [vector search guide](https://orm.drizzle.team/docs/guides/vector-similarity-search)).
- drizzle-kit 0.31.11: `driver: "pglite"` takes only a URL and opens `new PGlite(url)` with no
  extensions — `migrate`/`push` against a vector schema would fail, and would be a second process on
  the directory. It never emits `CREATE EXTENSION`. **Use it for `generate` only**; extensions in a
  `generate --custom` migration; migrations applied inside the daemon.
- The pglite migrator reads `<folder>/meta/_journal.json` and the `.sql` files at run time — the
  package must ship the folder, found through `import.meta.url`.

## Operations

- Backup: `dumpDataDir()` → tarball, `loadDataDir` restores; docs warn a dump "may not be compatible
  with other Postgres versions" ([api](https://pglite.dev/docs/api)). `@electric-sql/pglite-tools`
  has a logical `pg_dump`.
- `kill -9` during continuous inserts, three runs: every reopen recovered all committed rows.
- **A 0.4.6 (PG 17) directory fails in 0.5.8** ("PGlite failed to initialize properly"). Docs:
  minor upgrades are dump from the old version, import into the new
  ([upgrade](https://pglite.dev/docs/upgrade)) — both versions installed under aliases.
