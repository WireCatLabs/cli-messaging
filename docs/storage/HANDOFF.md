# Handoff — storage and search for cli-messaging, then max-cli

You are picking up the move of the message store to Drizzle, an async store API, and the search
subsystem in the owner's requirements. The research is done and the engine is ruled — **SQLite FTS5
behind an async store interface, no daemon in phases 1–2**; nothing is built. **Your first job is the
phase 1 plan, not code**: write it, show it, wait for approval.

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

1. [`decisions.md`](decisions.md) — the rulings: SQLite FTS5 (NEED-374), every word with an
   any-word fallback, BM25 plus trigram typo correction (NEED-375), no daemon in phases 1–2
   (NEED-376), and why. The requirements still say PGlite in §2, §7, §8, §25 — the rulings override
   them.
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
  versions (~~max-cli still pins cli-messaging 0.13.0~~ **Correction 2026-09-30:** max-cli pins 0.29.0, tg-cli 0.27.0). A schema change here reaches both; `min_compatible`
  in `migrations.ts` is what lets an older CLI open a newer file today.
- **The store is synchronous today** in both repositories. **Correction 2026-09-30:** the ~83 call sites are max-cli's *own profile cache*, a later phase — cli-messaging's store has few callers (max-cli `src/bot/keep.ts`, `bot-people.ts`). Going async is ruled; do it store by store with the tests green after each.
- **Drizzle's `node:sqlite` driver exists only in drizzle-orm 1.0 rc** (1.0.0-rc.4), not in stable
  0.45.3. Its SQLite drivers are synchronous; wrap them in the async interface. Each driver imports
  its runtime at top level — load by dynamic `import()`, or Bun breaks Node and vice versa.
- **Drizzle's migrator** reads its log before a plain `BEGIN`, so two processes can apply one migration, and it never refuses a newer file; **`drizzle-kit generate` rebuilds a table (`DROP TABLE`) for a constraint change**, which on `messages` drops the search triggers. (Found by the phase 1 plan, 2026-09-30.)
- **FTS5 and its triggers cannot be expressed in Drizzle** — a `drizzle-kit generate --custom`
  migration, and `sql` for `MATCH`/`bm25()`. Postgres extensions are the same story.
- **`unicode61 remove_diacritics` strips Latin accents only** — normalize ё→е, й→и yourself. **Correction 2026-09-30:** the fixture's normalizer already does, and folding merges real words too (мой/мои, año/ano) — decide it deliberately.
- **SQLite picks a slow plan** for FTS5 plus filters with a plain `JOIN` (`MATCH` per row); write
  it as `CROSS JOIN` and check `EXPLAIN QUERY PLAN` in a test.
- **PGlite was measured and ruled out** — do not reopen it without reading the research; the reasons
  (no lock, dump on every minor upgrade, wrong rows under a filter, 5× memory) are in `research/`.
- **Releases:** cli-messaging has no CHANGELOG and releases with `bin/release`; tg-cli asks for
  releases. Base every PR on `main`, never stack.

## 5. Do not read, do not touch

- `bench/search/node_modules`, generated data (it is deleted; `node gen.ts` makes it again).
- max-cli's `docs_ai/journal/` — grep it for an id, never read it through.
- tg-cli's code beyond its imports of `@leemour/cli-messaging` (listed in `current-state.md`).
- The graph, AI enrichment and semantic phases — out of scope until lexical search ships. They
  will run in **background workers** (ruled; [`daemon.md`](daemon.md)) — keep the store API usable
  from a long-running process (no per-call global state, transactions short).
- Do not rewrite `requirements.md`; record disagreements in `decisions.md`.

## Decisions you will make yourself — make them knowingly

- Whether max-cli's extra tables become generic cli-messaging tables or max-specific tables in the
  same database.
- How filters reach the full-text index — **Correction 2026-09-30:** decided in phase 2 (`decisions.md`), not phase 1; the fixture's schema is not the store's, so store-level measurement needs a loader first. `./run.sh 1000000` also builds PGlite and Docker Postgres.
- The bridge from `schema_migrations` to Drizzle's migration log for existing files.

## How to check

```sh
pnpm lint && pnpm typecheck && pnpm test         # in cli-messaging
cd bench/search && pnpm install && node gen.ts 1000000 42 && ./run.sh 1000000   # the fixture
./run.sh 100000 bun                               # parity under Bun
```

In max-cli: `pnpm lint && pnpm typecheck && pnpm test`, and `pnpm release:check` before any release.
