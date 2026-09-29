# Handoff — storage and search for cli-messaging, then max-cli

You are picking up the move of the message store to Drizzle, an async store API, and the search
subsystem in the owner's requirements. The research is done; nothing is built. **Your first job is
the phase 1 plan, not code** — and it cannot start until the engine is ruled (below).

## 1. What this is

`@leemour/cli-messaging` is the messenger-neutral half of two published CLIs, `tg-cli` (Telegram)
and `max-cli` (MAX): shared commands, domain types and one SQLite message store for every messenger
and account. `max-cli` also keeps its own per-profile SQLite cache for the personal account. The
owner wants one store, in cli-messaging, fast local search over millions of messages (BM25, typos,
filters), and later optional conversation graphs and semantic search.
Full description: [`../../README.md`](../../README.md).

## 2. Entry points

| What | Where |
|---|---|
| The owner's requirements, verbatim | [`requirements.md`](requirements.md) |
| What is ruled and what is open | [`decisions.md`](decisions.md) — **read before anything else in this folder** |
| The stores, who opens them, the servers that exist | [`current-state.md`](current-state.md) |
| Evidence | [`research/`](research/) — benchmark, PGlite measured and web-checked, Drizzle |
| The benchmark fixture (requirements §26) | [`../../bench/search/`](../../bench/search/) — `results.md` and the scripts |
| Plans of this repository | [`../plans/`](../plans/) — the background-process plan (`2026-09-27-background-process.md`) matters if a daemon is ruled in |
| max-cli's rules and journal | `max-cli/CLAUDE.md`, `max-cli/docs_ai/` (private; journal ids `NEED-374…376` live there) |

## 3. Read for this task, in this order

1. [`decisions.md`](decisions.md) — which questions are open (engine NEED-374, search semantics
   NEED-375, daemon NEED-376) and the recommended answers. If the owner has not answered, **stop and
   ask**; do not pick.
2. [`current-state.md`](current-state.md) §"What this means" — the five problems any design must
   answer.
3. [`research/2026-09-29-search-benchmark.md`](research/2026-09-29-search-benchmark.md) — which
   query shapes are slow and why (filters outside the full-text index), and the SQLite `CROSS JOIN`
   plan fix.
4. [`requirements.md`](requirements.md) §4–§11, §22–§26, §29–§31 — the model, search API, commands,
   migration from SQLite, performance targets, invariants, phases. The graph and AI sections
   (§12–§21, §27–§28) are later phases.
5. `src/store/store.ts`, `src/store/migrations.ts`, `src/store/driver.ts` — the store you replace.
6. In max-cli: `src/cache/store.ts` and `src/cache/schema.ts` — the cache that folds in afterwards.

## 4. What will bite you

- **tg-cli and max-cli write the same `messages.db`** from separate processes and different
  versions (max-cli still pins cli-messaging 0.13.0). A schema change here reaches both; `min_compatible`
  in `migrations.ts` is what lets an older CLI open a newer file today.
- **The store is synchronous today** in both repositories (~83 call sites in max-cli read results
  without `await`). Going async is ruled; do it store by store with the tests green after each.
- **Drizzle's `node:sqlite` driver exists only in drizzle-orm 1.0 rc** (1.0.0-rc.4), not in stable
  0.45.3. Its SQLite drivers are synchronous; wrap them in the async interface. Each driver imports
  its runtime at top level — load by dynamic `import()`, or Bun breaks Node and vice versa.
- **FTS5 and its triggers cannot be expressed in Drizzle** — a `drizzle-kit generate --custom`
  migration, and `sql` for `MATCH`/`bm25()`. Postgres extensions are the same story.
- **`unicode61 remove_diacritics` strips Latin accents only** — normalize ё→е, й→и yourself.
- **SQLite picks a slow plan** for FTS5 plus filters with a plain `JOIN` (`MATCH` per row); write
  it as `CROSS JOIN` and check `EXPLAIN QUERY PLAN` in a test.
- **If PGlite is ruled in:** two processes on one data directory corrupt it silently — own lock file
  first; `pglite-socket` runs one query at a time and has open deadlocks; every minor PGlite upgrade
  needs a dump and restore; with a chat filter, pg_textsearch 1.3.1 returned non-matching rows (keep
  `score < 0`).
- **Releases:** cli-messaging has no CHANGELOG and releases with `bin/release`; tg-cli asks for
  releases. Base every PR on `main`, never stack.

## 5. Do not read, do not touch

- `bench/search/node_modules`, generated data (it is deleted; `node gen.ts` makes it again).
- max-cli's `docs_ai/journal/` — grep it for an id, never read it through.
- tg-cli's code beyond its imports of `@leemour/cli-messaging` (listed in `current-state.md`).
- The graph, AI enrichment and semantic phases — out of scope until lexical search ships.
- Do not rewrite `requirements.md`; record disagreements in `decisions.md`.

## Decisions you will make yourself — make them knowingly

- Whether max-cli's extra tables become generic cli-messaging tables or max-specific tables in the
  same database.
- How filters reach the full-text index (FTS5 with the chat id as an unindexed column, per-chat
  partial strategy, or pre-filter by rowid ranges) — measure with the fixture.
- The bridge from `schema_migrations` to Drizzle's migration log for existing files.

## How to check

```sh
pnpm lint && pnpm typecheck && pnpm test         # in cli-messaging
cd bench/search && pnpm install && node gen.ts 1000000 42 && ./run.sh 1000000   # the fixture
./run.sh 100000 bun                               # parity under Bun
```

In max-cli: `pnpm lint && pnpm typecheck && pnpm test`, and `pnpm release:check` before any release.
