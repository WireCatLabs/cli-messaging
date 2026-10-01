# Handoff — the rest of phase 2, and tg and max on it

Written 2026-10-01, when phase 2 items 1–7 were merged (none released yet). Three threads are left;
they do not touch the same files and can run in parallel, one PR at a time each.

## 1. What this is

`@leemour/cli-messaging` keeps one SQLite message store for tg-cli and max-cli. Phase 2 gave it word
search: a word index (store version 12), typo correction, a query language, and `messages search` /
MCP `messages_search` on top. Its own SQLite package, `@leemour/cli-messaging-sqlite`, makes sure the
store runs on a SQLite new enough for that index. The full picture: [`../HANDOFF.md`](../HANDOFF.md).

## 2. Entry points

| What | Where |
|---|---|
| The plan, approved, with what is built in its header | [`../plans/phase-2.md`](../plans/phase-2.md) — §5 items 8–10 are left |
| The SQLite plan, approved | [`../plans/sqlite-runtime.md`](../plans/sqlite-runtime.md) — item 5 is left |
| How the store and search are built now | [`../../dev/ARCHITECTURE.md`](../../dev/ARCHITECTURE.md#the-store) — "Two text indexes" and the paragraphs after it |
| Rulings | [`../decisions.md`](../decisions.md) |
| Trail (optional, private) | max-cli `docs_ai/journal/2026-10-01-storage-phase-2.md` — ids such as `FIND-443`; grep, never read through |

## 3. The threads, and what to read for each, in order

### A · tg-cli and max-cli on the next cli-messaging release (SQLite plan item 5)

**Done 2026-10-02:** tg-cli [#215](https://github.com/leemour/tg-cli/pull/215) and max-cli
[#317](https://github.com/leemour/max-cli/pull/317) are on 0.99.0, and `parity.json` has the three
`messages search` options in all CLIs ([#392](https://github.com/leemour/cli-messaging/pull/392)). The
status below is how it stood mid-way.

**Status 2026-10-02:** `ensureSqlite()` first, `engines.node` and the Node 22.16 pages are merged
on 0.98.0, which already exports `./sqlite-runtime` — max-cli
[#313](https://github.com/leemour/max-cli/pull/313), tg-cli
[#214](https://github.com/leemour/tg-cli/pull/214). Left: the move to 0.99.0 (the weekly breaking
release, with #372) — tg by this thread, together with removing `TELEGRAM_CAPABILITIES`; max by the
P8 bot thread, because max's own `bot callbacks|commands|webhooks` clash with the shared ones of #374
and max fails at start until they go. Then one `parity.json` change: `--newest`, `--context` and
`--source` of `messages search` to `in` for each CLI on 0.99.0.

Waits for a cli-messaging release that has #318 and #362 (npm's `latest` was 0.97.0 without them).

1. [`../plans/sqlite-runtime.md`](../plans/sqlite-runtime.md) §3 R2 and R5 — what `ensureSqlite()`
   must run before, and why.
2. `src/sqlite-runtime.ts` — `ensureSqlite`, exported as `@leemour/cli-messaging/sqlite-runtime`.
3. tg-cli `src/bin/tg.ts`, max-cli `src/bin/max.ts` — both import `../program.js` statically today.

The change in each CLI: `await ensureSqlite()` first, then `await import("../program.js")` (a static
import loads every module before it runs); `engines.node` → `^22.16.0 || >=24`; the installation
page says Node 22.16 or newer; `'@leemour/cli-messaging-sqlite@1.0.0'` in `minimumReleaseAgeExclude`
of `pnpm-workspace.yaml`; max regenerates `docs/commands.md` (`pnpm generate`). Then in
cli-messaging's `parity.json`, `messages search` `--newest` and `--context` move from `planned` to
`in` for the CLI that has them.

### B · Search across accounts and messengers (phase 2 item 9, S13)

**Done 2026-10-02:** [#377](https://github.com/leemour/cli-messaging/pull/377).

1. [`../plans/phase-2.md`](../plans/phase-2.md) S13 — the default stays the current account;
   `in:<messenger>`, `in:all`, `--source`; resolution inside the chosen accounts; pretty output names
   the messenger; MCP `source`.
2. `src/services/messages.ts`, `scopeOf` (`:371`) — refuses `in:` today (`:383`); this is where the
   accounts list grows.
3. `src/services/messages.ts:197` and `:202` — context and completeness use the one `account`; with
   several accounts each hit's own account is needed (its `locator` carries it).
4. `src/search/query.ts:6`, `:92` — `in:` already takes any messenger the store holds, plus `all`
   (#345); the parser is given the list.
5. `src/store/sqlite/words.ts:27` — `SearchScope.accounts` is already a list; the store needs nothing.

### C · The benchmark through the store (item 8), then max's bot search (item 10)

1. [`../plans/phase-2.md`](../plans/phase-2.md) §6, "Acceptance" — the targets.
2. `bench/search/store.ts` (loads a corpus through `openStore`), `bench/search/store-search.ts`
   (searches it), `bench/search/gen.ts` (the corpus; item 8 adds look-alike words).
3. `src/store/sqlite/words.ts:17`, `SCOPE_TOKEN_LIMIT` — 20,000 is provisional; item 8 sets it from
   chats of 10k, 50k and 100k messages.
4. Item 10: max-cli `src/commands/bot-people.ts:207` calls `store.find({ text })`; it moves to
   `search` (`src/search/search.ts:61`). Removing `text` from `find` afterwards breaks a stable export
   (`MessageStore`), so it waits for a weekly breaking release.

## 4. What will bite

- **`main` moves every few minutes.** Every PR conflicted at least once today, mostly in
  `CHANGELOG.md`. Squash with `git reset --soft $(git merge-base HEAD origin/main)` — never
  `--soft origin/main` after a fetch: that commit silently reverted ~900 lines of others' work once
  (caught before merge). Check `git show --stat HEAD`, not `git diff origin/main`: worktrees share
  remote refs, and another session's fetch moves `origin/main` under you.
- **A conflicting PR runs no checks.** A wait loop on CI then waits forever; stop it on
  `mergeable == CONFLICTING`.
- **Parity runs on a PR only when `parity.json` or `src/parity/` changes.** A new option of a shared
  command needs a `parity.json` row (keys in order; `pnpm parity:render` after), and then wait for
  `main (tg)`, `main (max)` and `wording`, not just `CI`.
- **One release a day** (`bin/release` refuses within 24 h); a stable-export break once a week.
- **The machine is shared.** `/tmp` filled up twice today (EDQUOT: commands lose their output), and a
  load average of 255 made six tests time out that pass in 5 s alone. Clear your own scratch first;
  rerun when `uptime` is calm. `bench/search` writes corpora to `$SEARCHBENCH_DATA` (default
  `/tmp/searchbench-data`, shared with other sessions) — point it at your own folder; at 100k a
  store is ~150 MB.
- **`bench/search/store.ts` appends a row to `results.md`** on every run — commit only the rows you mean.
- **max mounts the shared `messages search` and `store`** (`max store migrate`, `max store fetch`
  exist), so notes that name those commands are right for both CLIs.
- **`score` is bm25 turned round: higher is better.** Inside the store it is still bm25 (lower is
  better); the flip is in `page` (`words.ts`).
- **The substring index keeps accents** (`FIND-443`): `len` does not find "València". Fixing it is a
  new migration and an owner's decision, not part of these threads.
- **A typo correction is at least three letters** (`SHORTEST_CORRECTION`, `FIND-444`): otherwise
  `len` becomes `en`. The plan says so in S7.
- **The SQLite package** is published by `.github/workflows/sqlite.yml` on a manual run with
  `publish` (trusted publisher set on npmjs.com). A new SQLite is a new package version first, then a
  cli-messaging bump.

## 5. Do not read, do not touch

- Phase 2 items 1–7's code beyond the anchors above — it is merged and tested.
- `drizzle/` and the version 12 migration — frozen.
- `packages/sqlite/` unless a SQLite update is the task.
- Phases 3–5 and their plans.

## Decisions you will make

- Thread B: how pretty output names the messenger and the CLI that opens a chat (S13 says "names the
  messenger before the chat title … and says which CLI opens the chat"); whether `--source` and `in:`
  given together and different is an error (S13: yes).
- Thread C: the `SCOPE_TOKEN_LIMIT` value, from the numbers; whether the store-load target of §6
  (≥ 6,000 rows/s at 1M) still holds — main measured ~3,000 rows/s at 100k on this machine on
  2026-10-01.

## How to check

```sh
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm docs:check && pnpm smoke:bun
pnpm build && pnpm check:dist && bun scripts/check-dist.ts
gh pr checks <n>   # every check, Parity included, before merging
```
