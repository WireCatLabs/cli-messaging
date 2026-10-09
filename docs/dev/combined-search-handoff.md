# Handoff — one message search without a language switch

The trail, optional, grep by `NEED-604`/`NEED-605`: cli-docs `docs/journal/2026-10-09-pr88-merge-and-landing-deploy.md`.

## 1. What this is

cli-messaging is the messenger-neutral half of tg-cli and max-cli ([`CLAUDE.md`](../../CLAUDE.md)).
Message search has two modes: strict Lucene (the default: exact words, field filters, Boolean
operators, ranked by word relevance) and `--language legacy` (a fallback chain: every word → word
beginnings → typo correction → any word → raw substring, each step only when the one before found
nothing). The owner finds the switch confusing and wants **one search**: Lucene syntax plus legacy's
forgiving matching, several matchers run in parallel, results merged and **ranked against the
query**, each hit labelled with how it matched so the agent can judge it — because in large chats
and notes many direct hits are irrelevant. Nothing is built yet. The owner asked for a measured
plan first: a ranking test set, then a plan to approve, then the build.

## 2. Orient in one call

Run in a worktree off `origin/main` (section 4, step 0):

```sh
{ echo "## search.ts — the legacy chain"; sed -n '55,106p' src/search/search.ts
  echo "## messages.ts — how a request picks lucene/legacy"; sed -n '74,78p;424,428p;684,690p' src/services/messages.ts
  echo "## messages-search.ts — strict search returns no corrections"; sed -n '397,432p' src/services/messages-search.ts
  echo "## lucene.ts — BM25 ranking only for unstemmed required words"; sed -n '436,486p' src/store/sqlite/lucene.ts
  echo "## notes-search.ts — the fusion pattern to reuse"; sed -n '249,256p;320,340p' src/services/notes-search.ts
  echo "## parser.ts — strict refuses ~ and points at legacy"; sed -n '255p' src/search/lucene/parser.ts
  echo "## searches.ts — saved searches store their language"; sed -n '82,92p' src/services/searches.ts
  echo "## spec — legacy kept for SDK callers until a breaking window"; sed -n '45,51p' docs/search/query-language-spec.md
  echo "## bot search runs the chain"; grep -n "search(" src/cli/bot/people.ts | head -3
  echo "## open search work"; gh pr list --search "search in:title" --limit 10
} > ~/.cache/combined-search-orient.txt 2>&1
```

Then read `~/.cache/combined-search-orient.txt` (about 215 lines). It shows: the five legacy steps and
the `Match` labels they already return; how CLI/MCP default to Lucene and when a RegExp forces legacy;
that `searchLucene` always answers `corrections: []`; that the BM25 rank is computed only when the
query has unstemmed required words; the reciprocal-rank-fusion loop notes search uses; the `~` error
text; how a saved search records `legacy`; the SDK compatibility promise; and any open PR on search.

## 3. Read in this order (only if the orient output is not enough)

1. `src/search/search.ts:1-54` — what `everyWord`, `correctWords` and `tagged` do, so the forgiving
   matchers can be reused as parallel matchers instead of a chain.
2. `src/store/sqlite/lucene.ts:92-110` and `:486-580` — what `matchQuery` returns and where a score
   comes from, so fused lists carry a comparable rank.
3. `src/services/embeddings.ts:700-760` — how conversation search already fuses words and meaning
   (`RRF_K`, `fused`), and that vectors exist per conversation chunk, not per message.
4. `bench/search-quality/README.md` — how the existing synthetic, offline benchmark is built and run;
   the new message-level set follows the same rules.
5. `src/services/search-all.ts:50-110` — how `search all` merges resources by rank; the result shape
   readers and MCP already accept.

## 4. Do

0. **Worktree.** `git -C /home/leemour/Projects/AI/cli-messaging worktree add -b feat/combined-search ../cli-messaging-wt-combined-search origin/main`.
   Other sessions work here at once ([`COORDINATION.md`](COORDINATION.md)); the main checkout is not yours.
1. **A message-level ranking test set, before any code change.** Use [cli-testing performance/search](https://github.com/WireCatLabs/cli-testing/blob/test/search-experiments/performance/search/README.md):
   a committed synthetic corpus (no real account, no network) with large noisy chats where many
   messages contain the query words but few answer the question; typos, word beginnings, Cyrillic and
   Latin, phrases, filters (`from:`, `chat:`, `date:`); no-answer queries. Label the relevant messages
   per query; split dev / held-out. Measure recall@10, MRR, nDCG@10 and no-answer false hits for
   the current strict search and the current legacy chain. Check: `python3 performance/search/run.py --messaging-root "$SEARCH_MESSAGING_ROOT" run > /tmp/search-baseline-new.json` from cli-testing
   — passes when both modes produce numbers for every query.
2. **A plan for the owner — `docs/dev/combined-search.md`.** Design, the baseline numbers, the
   targets, the breaking changes (section 5) and the release order. Stop and ask the owner to approve
   it; do not build before that.
3. **Build after approval.** Shape the plan leans to:
   - one query language — Lucene — and no `--language` option in the CLI or MCP;
   - matchers run in parallel for plain words: exact words and stems; word beginnings; corrected
     spellings; meaning, when the local model is installed (chunks mapped back to their messages);
   - lists merged by reciprocal rank fusion as in `notes-search.ts`, then the top candidates re-ranked
     against the whole query (all words present, proximity, phrase), with a cap per chat or
     conversation so one large chat cannot fill the page;
   - each hit carries `match` (reuse the `Match` labels in `search.ts`) and a score; `corrections`
     is filled again;
   - `--exact` keeps the current strict behaviour for scripts; filters, `AND`/`OR` and phrases stay exact.
   Decisions yours, settle each with the test set: candidate depth and the RRF constant (60 is what
   notes and conversations use); which re-rank signals earn their cost; the per-chat cap; whether the
   weak steps (any word, raw substring) stay as labelled low-rank candidates or go — the owner wants
   the agent to judge labelled candidates and objects to unlabelled noise; whether meaning is in the
   first release. Check per step: `pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm docs:check`,
   and the bench run beats the baseline on held-out without raising no-answer false hits.
4. **Consumers.** tg-cli and max-cli pin an exact cli-messaging version: release first, then a draft
   PR in each that bumps it and removes `--language` from their docs and skills (pattern: cli-messaging
   #800 with tg-cli #402 and max-cli #523). Changelog lines under the breaking heading in all three.

## 5. What bites

1. **The chain cannot simply be deleted.** `bot search messages` calls it with no language
   (`src/cli/bot/people.ts:257`) and `--regex` forces legacy (`src/services/messages.ts:424-428`).
   Move them onto the combined search or keep the chain as an internal function, not a user option.
2. **Saved searches store `language: "legacy"`** (`src/services/searches.ts:82-92`). Replaying them
   needs a conversion; `src/search/lucene/migration.ts` exists but its own warning says the result
   loses prefix, typo and any-word matching — with the combined search those come back, so decide
   whether a converted saved search is still a "legacy" record at all.
3. **There are two ranking paths, not one.** Unstemmed required words rank by BM25 over
   `message_words` (`rankMatch`, `src/store/sqlite/lucene.ts:439`, `:483`); a stemmed search
   ranks by stems through a set computed once and joined LEFT (`:491-492` — joined row by row it
   took 420 ms instead of 5 at 100k messages). A query with only filters has no rank at all. The
   fused score must not compare these raw scores with each other — fuse by rank position, as notes do.
4. **The SDK promise.** `MessagesService.search` and `searchStore` without a language keep legacy
   semantics for old SDK callers (`docs/search/query-language-spec.md:47-51`). Changing that is a
   stable-export break: follow [README, "How often, and what may break"](../../README.md#how-often-and-what-may-break).
5. **Meaning vectors are per conversation chunk.** `src/services/embeddings.ts` scores chunks; a
   meaning matcher for messages must map a chunk to its messages and not flood the list with one chunk.
   The e5-small cosine floor of 0.80 was chosen on conversations only (`bench/search-quality`).
6. **The real store is off limits.** No test or bench may open it; `MESSAGING_STORE` points elsewhere
   ([`TESTING.md`](TESTING.md)). A new index or table needs a migration number taken first in
   [`COORDINATION.md`](COORDINATION.md).
7. **The error text and docs point at legacy.** `src/search/lucene/parser.ts:255` tells users to add
   `--language legacy`; `docs/search/query-language.md` and the generated registry tables
   (`src/search/lucene/registry.ts`) describe it. `pnpm docs:check` fails on drift between them.

## 6. Do not touch

- `src/replies/**` — cli-messaging #800 (reply audience) is open.
- tg-cli and max-cli `docs/*.md` prose — branch `docs/reader-standards` in both repos rewrites every
  user page; it already drops `--language legacy` from the prose. Change only `docs/commands.md`
  (generated), skills and the changelog in the consumer PRs.
- `bench/search-quality/` — the conversation benchmark; add a new folder beside it.

## 7. Check

```sh
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm docs:check
```

The bench runs outside `pnpm test`, with no network and no real store. In tg-cli and max-cli, try an
unreleased cli-messaging with `bin/try-messaging` in the consumer worktree, never a committed `file:` path.
