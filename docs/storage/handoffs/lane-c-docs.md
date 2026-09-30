# Handoff — lane C: the storage documents catch up with what is built

Phase 1 item 11 of [`../plans/phase-1.md`](../plans/phase-1.md), plus the pages it has made stale.
Lanes A and B run at the same time ([`README.md`](README.md)); this lane edits documents only.

## 1. What this is

`@leemour/cli-messaging` is the shared half of tg-cli and max-cli; `messages.db` is its one SQLite store
for every messenger and account. In two days the store went async, gained Drizzle-generated
migrations (versions 6–11), a bundled Drizzle, and the tables max-cli's personal data needs. The code
and the CHANGELOG say so; the storage documents still describe the store of 0.27.0. The next agent
must be able to add a migration from the docs alone. Full picture: [`../README.md`](../README.md).

## 2. Entry points

| What | Where |
|---|---|
| What item 11 asks | [`../plans/phase-1.md`](../plans/phase-1.md) §5 item 11 |
| What was built and when | `CHANGELOG.md`, sections 0.49.0 to 0.60.0 — the facts, in order |
| The plan that added versions 7–11 | [`../plans/phase-1-max-tables.md`](../plans/phase-1-max-tables.md) |
| Rules for writing here | [`../../dev/CONVENTIONS.md`](../../dev/CONVENTIONS.md) — evidence labels, corrections in place, user pages |
| Trail (optional, private) | max-cli `docs_ai/journal/2026-09-3*-storage-phase-1.md` — grep, do not read through |

## 3. Read for this task, in this order

1. [`../../dev/ARCHITECTURE.md`](../../dev/ARCHITECTURE.md) "The store" and "Migrations" (`:26-52`).
   Answers: what the developer page says today — the migration paragraph was updated in #126, the
   store paragraph was not.
2. `src/store/sqlite/manifest.ts`, `scripts/bundle-migrations.ts`, `src/store/sqlite/manifest.test.ts`.
   Answers: the exact steps and guards of adding a migration (generate → review → manifest row →
   bundle → the "no rebuild" test).
3. `scripts/bundle-drizzle.ts`, `scripts/check-dist.ts`, `src/store/sqlite/drizzle/`, `biome.json`
   (the `noRestrictedImports` for `drizzle-orm`). Answers: why Drizzle is bundled and what breaks if
   it is imported elsewhere.
4. [`../current-state.md`](../current-state.md) and [`../decisions.md`](../decisions.md). Answers: which
   claims are now false.
5. `docs/plans/2026-09-29-parity-lanes.md:69` — the migration-number line (next free is 12).

## 4. What will bite you

- **Correct in place, marked, on developer pages** («**Correction 2026-10-xx:** …» at the claim, the old
  claim left visible) — [`../../dev/CONVENTIONS.md`](../../dev/CONVENTIONS.md). The README is a user
  page: plain current facts, no correction marks, no ids.
- **Check each claim against the code, not against the CHANGELOG alone** — a `path:line` for anything
  you call verified. `current-state.md` says the API is synchronous and lists 16 methods; there are
  36 now, all async.
- **Lane A is splitting `src/store/store.ts` into `src/store/sqlite/<aggregate>.ts` right now.** Do not
  describe the store's internal file layout — lane A writes that paragraph in its last PR. Describe the
  interface, the migrations, the bundle and the rules, which do not move.
- **"How to add a migration"** must include what is not obvious: announce the number in the lanes plan
  first (a PR of its own); `drizzle-kit generate` rebuilds a table with `DROP TABLE` for a constraint
  change, and on `messages` that drops the FTS triggers — the manifest test refuses it; triggers and
  FTS go in a `--custom` migration; two folders may share a version and apply as one;
  `min_compatible` rises only for a breaking change, and then tg-cli and max-cli bump the same day;
  add a test that the previous published build still opens the file (aliased dev dependency, as in
  `src/store/chat-members.test.ts`); `pnpm db:bundle` after every generate.
- `decisions.md` owes two things by plan item 11: **D5's deviations** — §4–§5 field names that map onto
  existing columns (`pk`, `native_id`, `provider_metadata`, `ingested_at`…; the table in
  [`../plans/phase-1.md`](../plans/phase-1.md) §4) — and **the answers to §9** (Q1 B, Q2 A).
- `docs/storage/HANDOFF.md` is the storage work's index; it points here. Leave its lane table alone
  unless a lane finishes.

## 5. Do not read, do not touch

- `src/**` — no code in this lane. A wrong comment you find goes into your PR description for the
  lane that owns the file, not into the code.
- `docs/storage/requirements.md` — the owner's words, verbatim.
- `docs/storage/research/**` — dated evidence; not updated.
- Phase 2 documents beyond a link ([`../search-indexes.md`](../search-indexes.md)).

## Decisions you will make — make them knowingly

- Whether "how to add a migration" lives in `ARCHITECTURE.md` or its own page linked from there.
- What to do with `current-state.md`: correct it in place, or mark it as a dated snapshot at the top
  and point to the current pages.

## How you work

One or two PRs based on `main`, docs only. `pnpm docs:check` must pass. Merge when every CI check
passed; no release is needed for documents.

## How to check

```sh
pnpm docs:check && pnpm lint
```
