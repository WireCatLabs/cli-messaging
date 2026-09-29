# Handoff — build phase 1 of the storage work

You build **phase 1** of the approved plan, [`plans/phase-1.md`](plans/phase-1.md): Drizzle, an async
store API, the new message and chat model, the migration of existing files, and the `db` commands. The
research is done, the engine is ruled, the plan is approved (2026-09-30). **Start with work item 1.**

## 1. What this is

`@leemour/cli-messaging` is the messenger-neutral half of two published CLIs, `tg-cli` (Telegram)
and `max-cli` (MAX): shared commands, domain types, and one SQLite message store for every messenger
and account (`messages.db`, shared by both CLIs). The owner wants that store on Drizzle with an async
API, fast local search over millions of messages (BM25, typo correction, substring, filters — phase
2), and later conversation graphs and semantic search in background workers.
Full description: [`../../README.md`](../../README.md).

## 2. Entry points

| What | Where |
|---|---|
| **The plan you build** | [`plans/phase-1.md`](plans/phase-1.md) — goal, decisions D1–D10, 11 work items, test plan, migration of existing files |
| What is ruled and why | [`decisions.md`](decisions.md) — the rulings table at the top overrides [`requirements.md`](requirements.md) where they differ (PGlite §2/§7/§8/§25) |
| How the search indexes work | [`search-indexes.md`](search-indexes.md) — phase 2 context; read once so phase 1 does not block it |
| The stores today and who opens them | [`current-state.md`](current-state.md) |
| Daemon or not | [`daemon.md`](daemon.md) — no daemon owns the database; `max serve` stays the MAX API daemon; background workers later |
| Evidence | [`research/`](research/), and the benchmark fixture [`../../bench/search/`](../../bench/search/) |
| This repository's rules | [`../dev/CONVENTIONS.md`](../dev/CONVENTIONS.md), [`../dev/TESTING.md`](../dev/TESTING.md) |
| max-cli's journal (private) | `max-cli/docs_ai/journal/` — ids such as `NEED-378` live there; grep, never read through |

## 3. Read for this task, in this order

1. [`plans/phase-1.md`](plans/phase-1.md) §3 (decisions D1–D10) and §5 (work items) — what to
   build and in which order. §6 is the test list for each item.
2. [`plans/phase-1.md`](plans/phase-1.md) §7 — how an existing `messages.db` upgrades, and D6: version
   6 raises `min_compatible` to 6, so older CLIs refuse the file.
3. [`decisions.md`](decisions.md) — the rulings, so you do not reopen one.
4. `src/store/store.ts`, `src/store/migrations.ts`, `src/store/driver.ts` — the store you change;
   `src/cli/messenger/context.ts` (`connected`, `withStore`) — how commands open it.
5. For item 5 only: [`../../bench/search/`](../../bench/search/) `results.md` and `sqlite.ts`.

## 4. What will bite you

- **Version 6 is a forced upgrade** (owner: «make sure the stuff is in sync and force upgrade of
  clis»). The release that carries it is a major release of cli-messaging, and **tg-cli and max-cli
  must ship their bump the same day** — otherwise the one not yet upgraded refuses `messages.db`. Plan
  that release with the owner; do not publish it alone.
- **Version 6 is frozen once released.** Item 6's acceptance (the 1M upgrade timing) happens before
  release, not after.
- **Drizzle's migrator is not used** (D1): it can apply one migration twice when two processes start
  together, and never refuses a newer file. drizzle-kit only generates SQL; our runner applies it under
  `BEGIN IMMEDIATE`. **`drizzle-kit generate` rebuilds a table with `DROP TABLE`** for a constraint
  change — on `messages` that also drops the FTS triggers. A test forbids rebuilds (§6, "No rebuild").
- **drizzle-orm `1.0.0-rc.4`, pinned exactly** — the only line with a `node:sqlite` driver. Check
  `npm view drizzle-orm dist-tags` before item 3; if 1.0 is final, use it and say so in the PR.
- **Each Drizzle SQLite driver imports its runtime at top level** — load it by dynamic `import()`, or
  Node breaks Bun and Bun breaks Node.
- **Transactions stay synchronous inside the async interface** (D3): an async callback inside a
  Drizzle transaction commits before its awaited part runs.
- **FTS5 tables and their triggers are hand-written** — a `--custom` migration; `MATCH`/`bm25()` via
  the `sql` tag.
- **Folding ё→е and й→и merges real words** (мой/мои, año/ano). The normalizer (D7) does it on
  purpose; do not "fix" it.
- **SQLite picks a slow plan** for FTS5 plus filters with a plain `JOIN` — write `CROSS JOIN` and
  assert the plan with `EXPLAIN QUERY PLAN` (item 8).
- **max-cli pins cli-messaging 0.29.0, tg-cli 0.27.0** — both open the same file; the store's callers
  in max-cli are `src/bot/keep.ts` and `bot-people.ts`.
- **`bench/search` defaults to one session's temp directory** (`common.ts:5-7`, `run.sh`) — set
  `SEARCHBENCH_DATA` to a directory of your own; `./run.sh 1000000` also builds PGlite and Docker
  Postgres. Item 5 fixes the default.

## 5. Do not read, do not touch

- Phase 2 and later: the word index, vocabulary, substring fallback, the search command, graphs, AI
  enrichment, vectors. [`search-indexes.md`](search-indexes.md) is for context only.
- max-cli's own profile cache (`src/cache/`) — a later phase (plan §8). Do not fold it in now.
- PGlite — measured and ruled out; do not reopen without reading `research/`.
- [`requirements.md`](requirements.md) — the owner's words, verbatim; record disagreements in
  `decisions.md`.
- `bench/search/node_modules`, and max-cli's journal beyond a grep.

## Decisions you will make yourself — make them knowingly

- The exact limit under which the normalization backfill runs on first open instead of only from
  `db migrate` (item 6 measures it; D6).
- Whether `message_count` is filled inside the version 6 migration or from `db migrate` (item 6).
- File names inside `src/store/` beyond what D4 fixes.

## How you work

- One work item = one PR, based on `main`, never stacked; a worktree per item.
- Merge only when every CI check passed, and only with the owner's word.
- Releases: `bin/release` after items 2, 6 and 8 — the one after item 6 is the coordinated major
  release above.

## How to check

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm smoke:bun     # every item
pnpm docs:check                                              # when docs change
cd bench/search && pnpm install && SEARCHBENCH_DATA=<dir> node gen.ts 1000000 42   # item 5 onwards
```
