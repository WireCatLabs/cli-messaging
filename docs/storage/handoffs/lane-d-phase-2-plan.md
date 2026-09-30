# Handoff — lane D: write the phase 2 search plan (plan only, stop for review)

Phase 2 is built **after** phase 1's lane A, the Drizzle port (owner, 2026-09-30: port first, then search; lanes B and C are done). The plan
can be written now: it is a document, and it touches no file the other lanes own
([`README.md`](README.md)). **Write the plan, show it, stop.** No code in this lane.

## 1. What this is

`@leemour/cli-messaging` is the shared half of tg-cli and max-cli; `messages.db` is its one SQLite store
for every messenger and account. Today search is FTS5 `trigram` over the raw text: any three letters,
newest first, no ranking. Phase 2 is the search the owner asked for: words ranked by BM25 over the
normalized text, typos corrected through a vocabulary, the substring index as a fallback, a typed
query language, and how complete the archive is for each chat searched. The rulings are made; the
plan turns them into work items. Full picture: [`../README.md`](../README.md).

## 2. Entry points

| What | Where |
|---|---|
| The rulings phase 2 follows | [`../decisions.md`](../decisions.md) — rows NEED-374 (SQLite FTS5), NEED-375 (every word, then any; BM25; trigram typo correction), NEED-379 (keep the substring index), NEED-400 (typed query language, completeness per chat) |
| How the indexes work, and the proposed order a search runs in | [`../search-indexes.md`](../search-indexes.md) — the last section says the phase 2 plan settles the order |
| The measurements | [`../research/2026-09-29-search-benchmark.md`](../research/2026-09-29-search-benchmark.md), `bench/search/results.md` |
| A working prototype of the whole pipeline | `bench/search/sqlite.ts` — word index, `fts5vocab` vocabulary, trigram candidates, edit distance |
| What phase 1 left ready for phase 2 | [`../plans/phase-1.md`](../plans/phase-1.md) D6 (`normalized_text`), D7 (normalizer), D9 (how a filter reaches the index — measured), §4 (`is_searchable`, `message_count`) |
| The owner's words | [`../requirements.md`](../requirements.md) §3, §5, §6, §26, §30 "Phase 2" |
| How a plan is written here | `CLAUDE.md` "Plan before building": goal, current state with `path:line`, decisions and why, ordered work items, test plan, open questions |

## 3. Read for this task, in this order

1. [`../decisions.md`](../decisions.md), the "Ruled" table. Answers: what is decided — do not reopen it.
2. [`../search-indexes.md`](../search-indexes.md). Answers: the five indexes, the measured scenarios, and
   the order you must settle.
3. `bench/search/sqlite.ts` and the benchmark's "Summary" and "Verdict". Answers: which queries are
   slow, what typo correction costs, what 1M and 10M look like.
4. [`../plans/phase-1.md`](../plans/phase-1.md) D9. Answers: the scope-token measurement — a token helps a
   small chat and hurts a big one, which is why `chats.message_count` exists.
5. `src/store/store.ts` `find` (`:547`) and `wordsOf`; `src/services/messages.ts` `search` (`:73`,
   `:136`); `src/cli/messenger/messages-command.ts:95` (`messages search`); the MCP search tool in
   `src/mcp/`. Answers: what search is today, and every caller the plan changes.
6. `src/store/normalize.ts`, `src/store/sqlite/backfill.ts`. Answers: what fills `normalized_text`, and
   that rows stored before version 6 may still be waiting for it.

## 4. What will bite you

- **Lane A is moving the store onto Drizzle** and splitting `store.ts` into
  `src/store/sqlite/<aggregate>.ts`; its last slice ports `find`/`search`. Plan against the module
  layout lane A lands, not today's line numbers, and sequence the build after it.
- **Building an FTS index over a big file takes seconds** (a word-index rebuild is 7.5–7.8 s at 1M in
  the benchmark), and a migration runs under `BEGIN IMMEDIATE` while other processes wait at most 5 s.
  The new index cannot be filled inside the migration on a large file — plan how it is built (in
  batches, from `store migrate`, the way the normalization backfill works) and what search does
  meanwhile.
- **`normalized_text` can be `NULL`** for a live message stored before version 6 in a file with more
  than 5,000 of them, until `store migrate` runs (lane B builds it). Search must not lose those rows.
- **Deleted messages have `text = ''` and no normalized copy** (NEED-393 A); the triggers keep every
  FTS index in step. An index over `normalized_text` needs its own triggers — hand-written, in a
  `--custom` migration; drizzle-kit does not model FTS5.
- **The new schema is additive** (a new FTS table, triggers, maybe a vocabulary table): `min_compatible`
  stays 6, and a build on version 6 still writes to the file — the triggers index its writes too. Take
  the migration number in `docs/plans/2026-09-29-parity-lanes.md` (next free is 12) before building.
- **A filter's cost depends on the chat's size** (D9): `CROSS JOIN` then filter for a big chat, a
  scope token for a small one. `chats.message_count` gives the size; the plan decides the rule.
- **`is_searchable`** exists and nothing honours it yet: the plan says where search reads it.
- **Commands are named noun, then verb**; `messages search` already exists and its MCP tool too.
  Machine mode prints one JSON value on stdout. Completeness per chat (NEED-400 A) comes from
  `sync_ranges` against the chat's newest message.
- **Drizzle helpers** are imported only through `src/store/sqlite/drizzle/core.ts` (Biome enforces it);
  `MATCH` and `bm25()` stay in `sql`.

## 5. Do not read, do not touch

- Any code — this lane writes `docs/storage/plans/phase-2.md` and nothing else.
- Phases 4–5 (AI linking by the user's agent, embeddings) beyond a sentence on what phase 2 must not
  block. **Phase 3 is already planned and approved** ([`../plans/phase-3.md`](../plans/phase-3.md)):
  read its schema and work items so phase 2 does not take a migration number or a table it needs.
- PGlite: measured and ruled out ([`../research/`](../research/)); do not reopen.
- `docs/storage/requirements.md` — the owner's words, verbatim; disagreements go to `decisions.md`.

## Decisions you will make — make them knowingly

- The order a search runs in (words → typo-corrected words → any word → substring?), and when each
  step stops.
- How the word index is built on an existing large file, and what search answers until it is.
- The query language's grammar and error messages, and how each operator maps onto a filter or FTS.
- Which parts of the prototype's vocabulary and trigram tables become schema, and which are derived.

## How you work

Write `docs/storage/plans/phase-2.md` in the shape of [`../plans/phase-1.md`](../plans/phase-1.md): evidence labels
(**verified** with a `path:line` or a command, **docs say**, **inferred**), decisions with why,
work items each one PR, a test plan with the acceptance numbers (p95 at 1M against the benchmark,
recall on the fuzzy cases), open questions for the owner. A measurement that decides something may
use `bench/search` with `SEARCHBENCH_DATA` pointing at your own directory. Open it as a PR, ask the
owner to review, and stop.

## How to check

```sh
pnpm docs:check
```
