# Handoff — server search beside the archive, and the search docs (2026-10-07)

The trail, optional, grep `server search` or `stemm`:
`max-cli/docs_ai/journal/2026-10-07-competitor-parity.md` (private repo).

## 1. What this is

cli-messaging is the shared layer behind the `tg` and `max` CLIs: services, the local SQLite store, and
strict Lucene-profile search ([ARCHITECTURE](../dev/ARCHITECTURE.md)). Today every message search reads
**only the local store**. The messenger's own server search is never asked, and no flag selects it.
`--sync-first` fetches recent messages into the store before the local search
([sync-first](../search/sync-first.md)). The stemmed-search plan put server search out of scope as
`--backend live|archive|both` ([plan §8](2026-10-04-stemmed-search.md)).
**Your job:**
1. Plan server search.
2. Add a flag that picks archive, server, or both.
3. Make "both" the default: run the server and the archive searches in parallel, then merge, deduplicate
   and sort the results.
4. Update the internal and public search docs: the new feature, plus the stemmed search
   (`exact:` and `--exact`) that the website does not describe yet.

## 2. Orient in one call

```sh
R=~/Projects/AI/cli-messaging; T=~/Projects/AI/tg-cli; M=~/Projects/AI/max-cli; D=~/Projects/AI/cli-docs
{ for r in $R $T $M $D; do git -C $r fetch -q; echo "== $(basename $r): $(git -C $r log -1 --format='%h %s' origin/main) · pkg $(git -C $r show origin/main:package.json | grep -oE '"(version|@leemour/cli-messaging)": "[^"]*"' | tr '\n' ' ')"; done
  echo "== port.ts: core, server reads, the only server 'search' today (by sender)"; git -C $R show origin/main:src/cli/messenger/port.ts | sed -n '104,156p'
  echo "== port.ts: how capability groups compose the adapter"; git -C $R show origin/main:src/cli/messenger/port.ts | sed -n '444,460p'
  echo "== services/messages.ts: search and stats = refresh, then local search"; git -C $R show origin/main:src/services/messages.ts | sed -n '366,392p'
  echo "== search-refresh.ts: bounds, permission key, envelope"; git -C $R show origin/main:src/services/search-refresh.ts | sed -n '10,23p;53,56p'
  echo "== messages-search.ts: coverage envelope"; git -C $R show origin/main:src/services/messages-search.ts | sed -n '32,45p'
  echo "== CLI search flags"; git -C $R show origin/main:src/cli/messenger/messages-search-command.ts | sed -n '15,42p'
  echo "== tg adapter: Telegram server search used only by sender"; git -C $T show origin/main:src/telegram/adapter.ts | sed -n '322,336p'
  echo "== site page that is stale (stems 'not used yet')"; git -C $D show origin/main:content/docs/search-architecture.mdx | sed -n '66,78p'
  echo "== public tg guide, words section"; git -C $T show origin/main:docs/search.md | sed -n '18,32p'
} > ~/.cache/server-search-orient.txt 2>&1
```

Then read `~/.cache/server-search-orient.txt` (about 210 lines). It shows:
- the newest commit and pinned versions of the four repos;
- the adapter interface: the only server "search" today is `historyFrom`, Telegram's search by sender;
- how capability groups become an optional part of the adapter;
- the service where search runs: refresh first, then the local search. The server search joins here;
- the sync-first bounds, its permission key and its answer shape. Copy this pattern;
- the coverage block of the answer;
- the CLI search flags;
- the tg adapter call that uses Telegram's `searchMessages`;
- the website paragraph that still says stems are not used;
- the public tg guide that already explains word forms.

## 3. Read in this order (only if the orient output is not enough)

1. `src/services/search-refresh.ts` (≈160 lines). How do you bound a network step that runs before a search:
   chats, time, messages, a permission key, and a `refreshed` block in the answer?
2. `src/services/messages-search.ts:57-160` (`prepareLucene`). How does a query become an AST plus resolved
   chats and people? Your server step translates this same AST.
3. `src/store/sqlite/lucene.ts`, from `driverOf` to the first `if (stemmed && exactTier` block. How are hits
   ranked: exact forms first, then the stems' bm25? Server hits must fit this order.
4. `docs/search/query-language.md`, the sections «Формы слов» and «Машинный контракт и охват». What does the
   documented contract promise callers? The `coverage`, `wordsReady`/`stemsReady` and `query` fields.
5. `~/Projects/AI/cli-docs/scripts/sync.ts`. Where does the website get the tg and max guides? (From their
   released tags, so edit the guides in tg-cli and max-cli, not in cli-docs.)

## 4. Do

1. **Find out what each messenger's server can search, before you design anything.**
   - **Telegram:** mtcute has per-chat `searchMessages` (already used by sender) and `searchGlobal`.
     Read their parameters in the mtcute docs (context7). Find out what they match (words? prefixes?
     morphology?), how they page, and their flood-wait limits.
   - **MAX:** its protocol code has no message search. The only "search" opcode is a contact lookup by
     phone (`max-cli/src/spec/operations/contacts.ts`). Check the PyMax reference the spec cites, or probe
     a test account.
   - If MAX has no message search, MAX stays archive-only, and a server search on MAX is refused with a
     capability error.
   - Check: write the answers, each with its source, at the top of the plan.

2. **Write the plan** at `docs/plans/<date>-server-search.md` (copy the shape of
   [the stemmed-search plan](2026-10-04-stemmed-search.md)). Then claim it in
   [the lanes plan](2026-09-29-parity-lanes.md#4-releases-while-lanes-run). These decisions are yours:
   - **How server results keep strict semantics.** The server's matching is not Lucene. The plan leans to:
     the server returns *candidates*, they are saved into the store (`saveMessages`), and the same local
     strict query then runs over archive plus fresh rows. Deduplication then comes free (one row per
     message), and the ranking stays the store's (exact first, bm25). Each hit is marked
     `source: archive | server | both`. The alternative, merging two ranked lists (reciprocal rank fusion,
     as `conversations search` does in `src/services/embeddings.ts:720`), keeps hits the local query
     rejects. Say which you choose and why.
   - **What can be sent to the server.** Only the parts it understands: words and phrases, `from:`,
     `chat:`, dates. Wildcards, regexes, `has:`, `tag:` and presets stay local filters. A query with no
     words skips the server.
   - **Flag and default.** `--backend archive|server|both` (the plan's name was `live`). The owner asked
     for "both" by default. Write down what "both" does when there is no network or no session, with
     `--offline`, and over MCP (`backend`).
   - **Bounds and permission.** The same shape as sync-first: chats, time and messages limits, its own
     permission key, and the server step never marks anything read.
   - **What the answer reports.** Something like `refreshed`: what the server returned, what failed, and
     whether it stopped at a bound.
   - **Questions for the owner.** Put open choices in a §9 section as `NEED-n`, as the stemmed-search plan
     did. Wait for the answers before writing the default.
   - Check: `pnpm docs:check` passes.

3. **Build it in small PRs**, each one of the plan's work items:
   - an adapter capability (`MessageSearch`, optional like `SenderSearch`) and its tg implementation;
   - the service step, run in parallel with the archive search under its bounds;
   - the flags on `messages search`, `stats messages show` (only if the server can count; otherwise say
     why not), `searches create`, and MCP;
   - `parity.json` entries marked as planned for the consumers;
   - recipes and tests.
   - Check: section 7 passes on each PR.

4. **Update the docs.**
   - **Internal (cli-messaging):**
     - `docs/search/query-language.md`: a section on server search, plus the contract fields;
     - `docs/search/sync-first.md`: how it relates to server search;
     - `docs/dev/ARCHITECTURE.md`: the search part;
     - the plan itself.
   - **Public, in tg-cli and max-cli:** `docs/search.md` (tg in English, max in Russian),
     `docs/topic-search.md` if it is affected, and each changelog.
   - **Website (cli-docs):**
     - `content/docs/search-architecture.mdx` and its `.ru.mdx` and `.es.mdx`: rewrite «Word forms» /
       «Формы слов» (stems are now used, `exact:` and `--exact`) and add server search;
     - bump cli-docs' `@leemour/cli-messaging` from 0.128.0 and run `pnpm search:generate`, so the
       search playground's parser knows the `exact` field and fields version 2.
   - The website shows the tg and max guides only after those CLIs release and `pnpm sync` runs.
   - Check: `pnpm docs:check` in cli-messaging, tg-cli and max-cli, and `pnpm search:check && pnpm build`
     in cli-docs.

## 5. What bites

1. **Server matching is not the store's matching.** Telegram decides on its own what matches a word (its
   rules are not documented here). If raw server hits are shown, `exact:`, `-word` and phrases stop
   meaning what the docs promise. Re-check server hits with the local query, or document precisely what
   the server results mean.
2. **The parallel step must not slow the archive answer without a bound.** Run both together, but give
   the server step a time limit (sync-first uses 30 s by default). When the limit is reached, the answer
   is the archive's plus a "server incomplete" note, never an error.
3. **Saving server hits writes to the store**, so the stems queue and the word index grow. That is fine:
   the write drain handles it. But `--offline` and a read-only MCP profile must not write. Check
   `refuseLocalWrite` and how the `messages.sync-first` permission is enforced.
4. **Consumers have a test matrix.** tg-cli and max-cli fail CI when a new option has no test and no
   reason: add an entry to each one's `scripts/test-matrix-untested.ts` that names the cli-messaging test.
   max-cli's pre-push hook checks `parity.json`, so a flag shown where the manifest says "none" blocks
   the push. Mount a flag only where the messenger supports it.
5. **Releases are rationed:** one every 2 hours, and a breaking change to a stable export at most once a
   week ([README](../../README.md#how-often-and-what-may-break)). `bin/release` refuses otherwise. A changed
   default is a "may break callers" entry; it is not a stable-export break.
6. **Other lanes bump tg and max often.** Look at both repos' `main` before bumping: it may already be on
   your version.
7. **A website change goes live only through the CLIs' releases.** `pnpm sync` copies the guides from the
   tg and max release tags, and cli-docs CI runs it.

## 6. Do not touch

- `src/search/snowball/*`: generated; change it only through `bin/snowball-update`.
- Migration numbers without a claim in the lanes plan.
- `bench/stemming/data/` in the main checkout (about 800 MB, ignored by git): kept so benchmarks can be
  rerun.
- Other lanes' open PRs and worktrees (`git worktree list`): rebase onto them, don't edit them.
- The legacy discovery chain (`--language legacy`): out of scope.

## 7. Check

```sh
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm docs:check && pnpm check:dist
```

In tg-cli and max-cli, after a bump: `pnpm lint && pnpm typecheck && pnpm test:matrix && pnpm docs:check`.
In cli-docs: `pnpm search:check && pnpm build`.
Live probes need a test account, never the owner's. Ask the owner for its profile name; it is not in
this file.
