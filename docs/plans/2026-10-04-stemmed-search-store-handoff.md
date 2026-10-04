# Handoff — stems in the store: migration 15, queue, fill, readiness, setting (2026-10-04)

The trail, optional, grep by `TASK-363`: `max-cli/docs_ai/journal/2026-10-04-competitor-parity.md` (private repo).

## 1. What this is

cli-messaging is the shared layer behind the `tg` and `max` CLIs: domain, services, local SQLite store,
strict Lucene-profile message search ([ARCHITECTURE](../dev/ARCHITECTURE.md)). Strict search matches whole
normalized words, so `квартира` misses `квартиру`. The owner approved Snowball stemming in a separate index,
on by default; the design is [the stemmed-search plan](2026-10-04-stemmed-search.md). The stemmer itself
(vendored Snowball 3.1.1, `createStemmer`, cache) is built in PR #526. **Your job is work item 3 of the plan
(§5): put stems into the store** — migration 15, the stem table, a queue, the JS fill and write drain,
readiness by row name, the store-wide `searchStemmers` setting and the rebuild when it changes. Queries do
not change in this PR.

## 2. Orient in one call

```sh
R=~/Projects/AI/cli-messaging
P=origin/docs/stemming-plan:docs/plans/2026-10-04-stemmed-search.md
{ git -C $R fetch -q
  for n in 524 526 505 508 504; do gh pr view $n -R leemour/cli-messaging --json number,state,title,headRefName -q '"#\(.number) \(.state) \(.headRefName) — \(.title)"'; done
  echo "== plan S1-S3: schema, when stems are written, cache"; git -C $R show $P | sed -n '41,99p'
  echo "== plan S5: one analyzer for index and query"; git -C $R show $P | sed -n '112,131p'
  echo "== plan S13: store-wide setting, rebuild on change"; git -C $R show $P | sed -n '220,258p'
  echo "== plan §4 not to do, §5 work items"; git -C $R show $P | sed -n '276,298p'
  echo "== stem.ts API (PR #526)"; git -C $R show origin/feat/stemming-foundation:src/search/stem.ts | sed -n '8,30p;56,80p'
  echo "== search-index.ts: readiness hard-codes the row"; git -C $R show origin/main:src/store/sqlite/search-index.ts | sed -n '5,30p'
  echo "== search-index.ts: reset pattern"; git -C $R show origin/main:src/store/sqlite/search-index.ts | sed -n '195,215p'
  echo "== how migrations are made"; git -C $R show origin/main:docs/dev/ARCHITECTURE.md | sed -n '172,183p'
  echo "== migration number claim"; git -C $R show origin/main:docs/plans/2026-09-29-parity-lanes.md | sed -n '77,77p'
} > ~/.cache/stems-store-orient.txt 2>&1
```

Then read `~/.cache/stems-store-orient.txt`. It shows:
- which PRs are merged;
- the plan sections that define your schema, triggers, queue, cache and setting;
- the exact stemmer API you call;
- the readiness code you generalize;
- the reset pattern you copy for a rebuild;
- the migration recipe;
- the line where migration 15 must be claimed.

## 3. Read in this order (only if the orient output is not enough)

1. `drizzle/20261001110736_version-12-word-index/migration.sql` (49 lines) — the pattern to mirror: a
   contentless FTS5 table with delete support, a `scope` column, triggers, and the "fill on the spot only
   up to 5,000 messages" rule.
2. `src/store/sqlite/search-index.ts:63-195` — how `fillSearchIndex` batches under `BEGIN IMMEDIATE`, stops on
   `until`, and reports progress. Your `fillStems` has the same shape.
3. `src/store/store.ts:462-480` and `:940-950` — where the store opens, migrates, backfills small files,
   and exposes `fillSearchIndex`. Your drain hooks in here.
4. `src/services/messages.ts:112-124` and `:418-425` — the 200 ms fill before a search (`SEARCH_FILL_MS`).
   Stems join this fill.
5. `src/cli/messenger/store-maintenance-command.ts:320-355` — `store migrate` and `store reindex`. Stems must
   be built and rebuilt there, with progress.

## 4. Do

1. **Claim migration 15 first.** Add the claim to `docs/plans/2026-09-29-parity-lanes.md:77` ("The next free
   number is 15" becomes 16, with a line saying what 15 is). Open it as its own small PR against `main`; that
   is the repo rule. Check: `pnpm docs:check` passes.
2. **Branch.** Start from `feat/stemming-foundation` (PR #526); you need `src/search/stem.ts`. Rebase onto
   `main` when #526 merges. Plan §5 says this item lands after #505 and #508. Check their state in the
   orient output; if they are still open, build anyway and rebase later.
3. **Schema (plan S1).** In `src/store/sqlite/schema.ts`, add the stem FTS5 table, the queue table, the
   `analyzer` record and `store_settings`. Then run `pnpm db:generate`, `pnpm db:bundle`, and add a manifest
   row in `src/store/sqlite/manifest.ts`.
   - The triggers only enqueue `messages.pk`. SQLite cannot call the JS stemmer.
   - Decision yours: the FTS5 tokenizer must split exactly as the word index does
     (`unicode61 remove_diacritics 2`). Keep `scope` the same as `message_words`, so step 5 can filter
     by chat and sender inside the index.
   - Check: `pnpm test src/store` passes, including a migration test on a version-14 file.
4. **Readiness by row name.** Make `searchIndexState` take the row name instead of the constant `INDEX`.
   Stems are ready only when their row is filled AND the queue is empty AND `analyzer` matches the current
   setting. Expose this as `stemsReady`; do not change `wordsReady`.
   - Check: a unit test for each of the three "not ready" causes.
5. **Fill and drain (plan S2, S3).**
   - `fillStems(database, { until, batch })`: make one `createStemmer(parseStemmers(setting))` per run,
     never one per batch. Read `messages.text` and write `stemTokens(text).join(" ")`.
   - The drain empties the queue after each store write, in `store migrate`, and in the 200 ms search fill.
   - Decision yours: whether to drain after every write or after N rows, depending on the write path's cost.
     The plan leans toward after every write.
   - Check: insert, edit and delete tests show the queue goes to zero and the stems follow the text.
6. **Setting and rebuild (plan S13).**
   - Add `config set searchStemmers.cyrillic|latin`. Validate it with `parseStemmers`, which already gives
     `invalid_stemmer`, and store it in `store_settings`. Say in the command output that the setting
     applies to the whole store.
   - A changed `analyzer` makes stemmed search answer `index_not_ready` with cause `stemmer_changed`.
   - Only `store migrate` and `store reindex` rebuild, copying the reset pattern in `resetSearchIndex`.
   - Check: a test that changes the setting shows "not ready", then reindex shows "ready" with the new
     identity.
7. **Docs and PR.**
   - Update `docs/dev/ARCHITECTURE.md` (store section) and the store/config command docs.
   - Changelog: "`store migrate` builds a stem index; queries unchanged".
   - PR body: Task → Why → What → Testing, and say it is work item 3 of #524.

## 5. What bites

1. **Older binaries keep writing to the same store file.** A tg or max pinned to an older cli-messaging
   runs the triggers (it gets the new schema) but never drains the queue. So readiness must depend on the
   queue being empty, never on a flag alone.
2. **Never rebuild inside the 200 ms search fill.** tg and max can pin different Snowball versions. If the
   quick fill rebuilt on an analyzer mismatch, they would rebuild each other's index in a loop. Only
   `store migrate` and `store reindex` rebuild.
3. **Stem `messages.text`, not `normalized_text`.** Stemming must come before folding (й→и, ё→е).
   `stemTokens` already does stem-then-fold. Feeding it folded text costs about 10 points of Russian recall.
4. **`normalize()` can split one stem into two index words** (for example `½` becomes `1⁄2`). The word index
   splits the same way, so positions agree. Step 5 will quote query stems as a phrase; don't "fix" this
   here.
5. **One cache per run.** The cache lives in the `createStemmer` object. A new stemmer per batch makes the
   1M build 4× slower: 28.6 s without the cache vs 7.5 s with it (PR #526).
6. **Every vendored Snowball `.js` file must be listed in `scripts/copy-snowball.ts`.** `tsc` does not copy
   plain `.js` files into `dist`, and `pnpm check:dist` will fail.
7. **Don't link the plan file from a committed doc until #524 merges.** `docs:check` fails on a link to a
   file that is not on `main`. Name the PR number instead.
8. **Migrations are frozen and forward-only.** Generate them; never edit generated SQL by hand after it is
   merged. A big store fills in batches, not inside the migration. Copy the 5,000-row rule from version 12.
9. **The store is shared by every profile and by tg and max.** The setting is store-wide on purpose (plan
   S13). Don't put it in per-profile config.

## 6. Do not touch

- `src/search/lucene/*`, `src/store/sqlite/lucene.ts`, the MCP search tool, `--exact`: query changes are
  work item 5, a separate breaking release.
- `bench/stemming/`: the 1M gate is work item 4, after #504 merges.
- The branches of #505, #508, #504 and #524: other open PRs. Rebase onto them; don't edit them.
- `src/search/correct.ts` (legacy typo correction), tg-cli, max-cli, cli-docs.
- `src/search/snowball/*`: generated; change it only through `bin/snowball-update`.

## 7. Check

```sh
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm docs:check && pnpm check:dist && bin/snowball-update --check
```

No messenger account or personal store is needed. All tests use temporary store files.
