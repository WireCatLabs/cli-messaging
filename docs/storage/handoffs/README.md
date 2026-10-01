# Storage phase 1 — the lanes that run in parallel

What is left of [`../plans/phase-1.md`](../plans/phase-1.md) as of 2026-09-30, split so several sessions
can work at once without editing the same files. Each lane's handoff says what to read, what bites and
how to check.

| Lane | Work | Owns | Handoff |
|---|---|---|---|
| A | items 7–8: the store's queries onto Drizzle, one module per aggregate | `src/store/store.ts`, `src/store/sqlite/*` (not `backfill.ts`), `src/testing/sandbox.ts`, `scripts/check-dist.ts`, `bench/search/store.ts` | [`lane-a-drizzle-port.md`](lane-a-drizzle-port.md) |
| B | items 9–10: `store info`, `check`, `migrate`, `backup`, `restore` — **done 2026-09-30** (#199, #205; released in 0.67.0, in tg-cli by tg-cli #135) | new files in `src/cli/messenger/`, the `storeCommand` group, `src/store/sqlite/backfill.ts`, the exports in `src/store/index.ts` | [`lane-b-store-maintenance.md`](lane-b-store-maintenance.md) |
| C | item 11: the storage and developer documents — **done 2026-09-30** (#196); a new fact about the store goes into [ARCHITECTURE](../../dev/ARCHITECTURE.md#the-store) with the PR that makes it | `docs/dev/ARCHITECTURE.md` (not the store layout paragraph), `docs/storage/*.md` | [`lane-c-docs.md`](lane-c-docs.md) |
| D | the phase 2 search plan — **done, approved 2026-10-01** (#216); built after lane A | `docs/storage/plans/phase-2.md` (new) | [`lane-d-phase-2-plan.md`](lane-d-phase-2-plan.md) |

**Done before the split:** items 1–6 (normalizer, async store, Drizzle schema and baseline, the
migration runner, the benchmark loader, store version 6); versions 7–11 for max-cli
([`../plans/phase-1-max-tables.md`](../plans/phase-1-max-tables.md)); Drizzle bundled into `dist`
(0.60.0, NEED-385 A).

## Rules every lane keeps

- **One PR at a time per lane, based on `main`, never stacked.** Rebase just before merging: other
  sessions merge to `main` every few minutes.
- **Merge when every CI check passed.** The owner allows merging and releasing without asking
  (2026-09-30); still ask before anything that raises `min_compatible`.
- **Release with `bin/release` from a clean `main`.** If another session published the same number in
  the meantime, the run fails; run it again and it takes the next free version.
- **CHANGELOG**: entries go under `## Unreleased`, never under a released version — a rebase can
  silently move an entry into the section just released; look at where it landed.
- **No new store migration** in any lane. If one turns out to be needed, take the number in
  [`../../plans/2026-09-29-parity-lanes.md`](../../plans/2026-09-29-parity-lanes.md) first (next free
  is 12) and tell the other lanes.
- **A file another lane owns** is changed by that lane: say what you need in its PR thread, or leave a
  note in max-cli's journal.
