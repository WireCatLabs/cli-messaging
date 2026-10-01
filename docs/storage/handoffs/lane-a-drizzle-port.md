# Handoff — lane A: the store's queries onto Drizzle, one module per aggregate

Phase 1 items 7 and 8 of [`../plans/phase-1.md`](../plans/phase-1.md). ~~**Nothing of it is built yet.**~~ **Correction 2026-10-01:** all six slices are merged (#194, #206, #208,
#215, #232, #244) and released in 0.77.0; the layout is described in
[ARCHITECTURE](../../dev/ARCHITECTURE.md#the-store).
Lanes B and C run at the same time ([`README.md`](README.md)); this lane alone edits `src/store/store.ts`.

## 1. What this is

`@leemour/cli-messaging` is the shared half of tg-cli and max-cli. `messages.db` is one SQLite file for
every messenger and account, behind the async `MessageStore` interface. Today every method is
hand-written SQL in one 1,300-line file. Phase 1 moves the SQL to Drizzle (1.0.0-rc.4) and splits the
file into one module per aggregate behind the same interface, so a later repository split
(NEED-406 B) is a move, not a rewrite. Full picture: [`../README.md`](../README.md).

## 2. Entry points

| What | Where |
|---|---|
| The plan: items 7–8, decisions D1–D4 | [`../plans/phase-1.md`](../plans/phase-1.md) §3, §5, §6 |
| The tables and methods added for max-cli (versions 7–11) | [`../plans/phase-1-max-tables.md`](../plans/phase-1-max-tables.md) — built, released in 0.57.0 |
| Rulings | [`../decisions.md`](../decisions.md) |
| How the migrations work now | [`../../dev/ARCHITECTURE.md`](../../dev/ARCHITECTURE.md#migrations) |
| Repository rules | [`../../dev/CONVENTIONS.md`](../../dev/CONVENTIONS.md), [`../../dev/TESTING.md`](../../dev/TESTING.md) |
| Trail (optional, private) | max-cli `docs_ai/journal/2026-09-3*-storage-phase-1.md` — grep, do not read through |

## 3. Read for this task, in this order

1. `src/store/store.ts` — the whole store. The anchors: `openStore` (:224) opens with `openCache`, not
   Drizzle yet; `storeOver` (:245) is the facade; `inTransaction` (:250) is the only transaction;
   `upsertChat` (:284), `identityOf` (:339), `upsertMessage` (:415), `tombstone` (:690); the object
   the facade returns (:749). Answers: what each method does, and which SQL is subtle.
2. `src/store/sqlite/open.ts` — `openSqlite` gives the same connection twice, as the seam and as
   Drizzle (`orm`). Answers: how to get `orm` into `storeOver`.
3. `src/store/sqlite/schema.ts` and `src/store/sqlite/drizzle/core.ts` — the tables, and the one place
   Drizzle helpers are imported from. Answers: what you can query with, and where to add `and`,
   `isNull`, `inArray`…
4. `src/store/*.test.ts` — about 90 tests, your safety net. Each new module keeps them green unchanged.
5. `bench/search/store.ts` and `bench/search/results.md` (last section) — the ingest baseline you must
   not lose: 7,614 rows/s at 1M on Node 24.

## 4. What will bite you

- **Drizzle queries are synchronous here.** On both drivers `.run()`, `.all()` and `.get()` return
  results, not promises (verified on Node 24 and Bun 1.3, 2026-09-30), and a Drizzle write inside our
  `BEGIN IMMEDIATE` rolls back with it. So: **use `inTransaction`, never Drizzle's `transaction`**, and
  never `await` inside a transaction (plan D3).
- **`drizzle-orm` is a development dependency** since 0.60.0, bundled into `dist` at build time. Import
  it only through `src/store/sqlite/drizzle/core.ts` (add what you need there); Biome refuses any other
  import. `pnpm build && pnpm check:dist` proves the bundle; run it on every PR — and once `openStore`
  uses Drizzle, extend `scripts/check-dist.ts` to a real `saveMessages` plus a read through `openStore`.
- **Vitest loads Drizzle from `node_modules`: about 200 ms per test file**, and CI has timed tests out at
  5 s before. When `openStore` starts using Drizzle, import the shims once in `src/testing/sandbox.ts`
  so the load happens outside test timing.
- **Behaviour to keep exactly:** the `coalesce(?, column)` upserts ("a copy that knows less never
  erases") stay `sql` fragments with `excluded.` references; `INSERT OR IGNORE` becomes
  `onConflictDoNothing`; keep `RETURNING`; an identity is updated **only on a real change** (the search
  trigger rewrites the index on every update of `name`); the injected clock `now()`.
- **Deletion (NEED-393 A)** — `tombstone` empties the text, drops the normalized copy, the revisions
  and the transcript. `upsertMessage` returns early for a tombstoned row, **except** when `seenAt` is
  later than the deletion: then the message comes back with its text and no empty revision (c6cfaca).
  Both rules have tests; keep them.
- **Triggers do work you cannot see in the SQL:** the FTS indexes (`messages_fts`, `chats_fts`,
  `identities_fts`) and `chats.message_count` follow inserts, updates of `text`/`deleted_at`, and
  deletes. Do not replace an `UPDATE` with delete-and-insert.
- **`find` is the hardest method** (`:547`): FTS `MATCH`, JSON extraction, per-chat limits, a regex
  path. Port it last; keep `MATCH` in `sql`. Item 8 adds the `EXPLAIN QUERY PLAN` test from plan §6
  (no `messages_fts` scan per message row — write `CROSS JOIN` if SQLite picks the slow plan).
- Item 8 also removes the stale doc comment on `wordsOf` (`:1291`, it describes version 3).

## 5. Do not read, do not touch

- `src/cli/**`, `src/mcp/**`, `src/services/**` — they call the facade; signatures do not change.
- The migrations (`drizzle/`, `src/store/sqlite/manifest.ts`, `migrations.ts`) — no schema change in
  this lane.
- `docs/dev/ARCHITECTURE.md` "Migrations" and `docs/storage/decisions.md` — lane C's.
- The `store` maintenance commands — lane B's.
- Phase 2 (word index, vocabulary, typo correction) and [`../search-indexes.md`](../search-indexes.md).

## Decisions you will make — make them knowingly

- The module list. Suggested, as plan D4: `src/store/sqlite/{accounts,identities,chats,messages,
  ranges,sync,transcripts}.ts`, each plain functions taking `{ orm, database, now }`; `storeOver` stays
  the facade and delegates.
- Which statements to `.prepare()` once if the benchmark regresses.

## How you work

One PR per slice, each based on `main` and merged before the next — never stacked:

1. `openStore` opens through `openSqlite`, `storeOver` receives `orm`; no query changes. The sandbox
   preload and the extended `check:dist` go here.
2. Accounts and identities (`saveAccount`, `savePeople`, `people`, contacts).
3. Chats and members (`saveChats`, `chats`, `countChats`, members, `chatsWith`, the parts of `applyDelta`).
4. Messages — the upsert, tombstone, reactions. **Acceptance:** `bench/search/store.ts` at 100k and 1M
   within 10% of the baseline, written into the PR.
5. Ranges, sync state, leases, transcripts, `purge`.
6. Reads and search (item 8): `messages`, `around`, `messagesWindow`, `message`, `find`/`search`,
   `chatStats`, the `EXPLAIN QUERY PLAN` test, search p95 through the store against `sqlite.ts`
   (Drizzle and async add under 1 ms). Release after it.

Merge when every CI check passed; releases with `bin/release` from a clean `main` — if another session
published the same number meanwhile, run it again: it takes the next free version.

## How to check

```sh
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm docs:check && pnpm smoke:bun
pnpm build && pnpm check:dist && bun scripts/check-dist.ts
pnpm build && cd bench/search && pnpm install && SEARCHBENCH_DATA=<dir> node gen.ts 1000000 42 && SEARCHBENCH_DATA=<dir> node store.ts build 1000000
```
