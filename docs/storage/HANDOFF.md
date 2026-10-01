# Handoff — the storage work: where it stands and where to start

Rewritten 2026-09-30, when phase 1 was split into lanes. The earlier brief (build item 1) is in git
history; the trail is max-cli's private journal (optional, below).

## 1. What this is

`@leemour/cli-messaging` is the messenger-neutral half of two published CLIs, `tg-cli` (Telegram) and
`max-cli` (MAX), and owns one SQLite message store for every messenger and account (`messages.db`,
shared by both CLIs). The owner wants it on Drizzle with an async API (phase 1), fast local search over
millions of messages (phase 2), a conversation graph without AI (phase 3), linking by the user's own
agent (phase 4) and search by meaning with local embeddings (phase 5). Full picture:
[`README.md`](README.md); the owner's words: [`requirements.md`](requirements.md) §30.

**Where it stands:** phase 1 items 1–6 are built and released (up to 0.60.0) — async store, Drizzle
schema and generated migrations, store version 6 (normalized text, message counts), Drizzle bundled
into `dist`. Versions 7–11 add what max-cli's personal data needs
([`plans/phase-1-max-tables.md`](plans/phase-1-max-tables.md), released in 0.57.0). Both CLIs pin a
version with all of it. Items 9–11 are done (lanes B and C: the `store info|check|migrate|backup|restore`
commands, in tg-cli; max gets them when its cache folds into the store). Items 7–8 — lane A, the Drizzle port — are done: #194, #206, #208, #215, #232, #244, released in
0.77.0. **Left:** phase 2, whose plan is approved ([`plans/phase-2.md`](plans/phase-2.md), 2026-10-01); its item 1,
the word index (store version 12), is built.
Phase 3 is planned and approved ([`plans/phase-3.md`](plans/phase-3.md)).

## 2. Entry points

| What | Where |
|---|---|
| **The work in flight — start here** | [`handoffs/README.md`](handoffs/README.md): the lanes, which files each owns, the rules every lane keeps |
| The plans | [`plans/phase-1.md`](plans/phase-1.md), [`plans/phase-3.md`](plans/phase-3.md) and [`plans/phase-2.md`](plans/phase-2.md) (approved; item 1 built) |
| What is ruled | [`decisions.md`](decisions.md) — overrides [`requirements.md`](requirements.md) where they differ |
| How search works and will work | [`search-indexes.md`](search-indexes.md) |
| Today's store and migrations | [`../dev/ARCHITECTURE.md`](../dev/ARCHITECTURE.md#the-store) ([`current-state.md`](current-state.md) is a 0.27.0 snapshot) |
| Evidence | [`research/`](research/), `bench/search/` |
| Rules | [`../dev/CONVENTIONS.md`](../dev/CONVENTIONS.md), [`../dev/TESTING.md`](../dev/TESTING.md) |
| Trail (optional, private) | max-cli `docs_ai/journal/2026-09-3*-storage-phase-1.md` — ids such as `NEED-437` live there; grep, never read through |

## 3. Read for this task, in this order

1. [`handoffs/README.md`](handoffs/README.md) — pick your lane; it lists the files you own.
2. Your lane's handoff — it says what to read next, in order, and why.

## 4. What will bite you

What bites **every** lane; each handoff adds its own.

- **Five to eight sessions push to one `main`.** Rebase just before merging; look where your CHANGELOG
  entry landed after a rebase — twice this week one slid silently into a section already released.
- **Releases race.** `bin/release` fails if another session published the same number first; run it
  again and it takes the next free version (0.59.0/0.60.0, 2026-09-30).
- **`drizzle-orm` is a development dependency**, bundled into `dist`. Import it only through
  `src/store/sqlite/drizzle/core.ts` (Biome refuses anything else); `pnpm build && pnpm check:dist`
  proves the bundle, under Node and Bun.
- **Drizzle queries are synchronous on our drivers** (Node and Bun, verified): use the store's own
  `inTransaction`, never Drizzle's `transaction`, and never `await` inside a transaction.
- **A deleted message leaves no text behind** (NEED-393 A): tombstone, empty text, no normalized copy,
  revisions or transcript. Only the messenger returning it after the deletion (`seenAt`) brings it back.
- **Migrations**: announce the number first (~~next free is **13**~~ **correction 2026-10-01:** the next free number lives only in the lanes plan §4 — 13 and 14 are taken; 12 is phase 2's word index,
  [`../plans/2026-09-29-parity-lanes.md`](../plans/2026-09-29-parity-lanes.md)); additive only;
  `min_compatible` rises only with the owner's word, and then tg-cli and max-cli bump the same day —
  their tests run on a sandboxed store and will not notice.
- **Folding ё→е and й→и merges real words** (мой/мои). On purpose; do not "fix" it.

## 5. Do not read, do not touch

- A file another lane owns ([`handoffs/README.md`](handoffs/README.md)).
- PGlite — measured and ruled out; do not reopen without reading `research/`.
- [`requirements.md`](requirements.md) — the owner's words, verbatim.
- Phases 3–5, beyond not blocking them.

## How you work

- One PR at a time, based on `main`, never stacked; a worktree per PR.
- Merge when every CI check passed. The owner allows merging and releasing without asking
  (2026-09-30); still ask before raising `min_compatible`.
- Record a finding or a decision in max-cli's journal (`docs_ai/journal/note.sh`), not in the chat
  alone.

## How to check

```sh
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm docs:check && pnpm smoke:bun
pnpm build && pnpm check:dist && bun scripts/check-dist.ts
```
