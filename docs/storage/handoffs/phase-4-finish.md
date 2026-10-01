# Handoff — finish phase 4: ship it to tg, document it, score it

Written 2026-10-01, when phase 4 items 1–5 were built and released in cli-messaging 0.96.0. What is left
is small and mostly waits on a release, a document and a measurement. The trail (optional, private) is
max-cli `docs_ai/journal/2026-10-01-storage-phase-3-build.md`; grep it, do not read it through.

## 1. What this is

`@leemour/cli-messaging` is the shared half of tg-cli and max-cli, with one SQLite store, `messages.db`,
for every messenger and account. Phase 3 groups a group chat's messages into conversations by rules;
phase 4 lets the **user's own AI agent** link what the rules leave open: the CLI hands it batches,
checks and stores its answers, and never calls a model itself. Full picture: [`../README.md`](../README.md).

## 2. Entry points

| What | Where |
|---|---|
| The plan, and which items are done (✅) | [`../plans/phase-4.md`](../plans/phase-4.md) — §5 work items, §6 test plan |
| Phase 3, which phase 4 builds on | [`../plans/phase-3.md`](../plans/phase-3.md) — C1–C7 and their dated corrections |
| Rulings | [`../decisions.md`](../decisions.md) — NEED-405: the CLI never calls a model |
| How the store is built, and the one method that is several transactions | [`../../dev/ARCHITECTURE.md`](../../dev/ARCHITECTURE.md#the-store) |
| Releasing, and the one-release-a-day rule | [`../../../README.md`](../../../README.md#releasing) |
| The other storage lanes | [`README.md`](README.md) |

## 3. Read for this task, in this order

The tasks, in the order to do them:

**T1 · Release, then land tg-cli #205.** Not before **2026-10-02 19:53 UTC**.
**Correction 2026-10-01:** 0.97.0 was already out (`e3edc1d`) with #342 in it, so #205 moved to 0.97.0 the same day; no release was needed.
1. [`../../../README.md`](../../../README.md#releasing), "At most one release a day" — when `bin/release`
   may run, and why `--blocked` is not the way here (the exception is for a fix that ships alone).
2. [tg-cli #205](https://github.com/leemour/tg-cli/pull/205) — its description says the three steps:
   bump to the new version, add it to `pnpm-workspace.yaml`'s `minimumReleaseAgeExclude`, run
   `pnpm parity:check`, mark it ready, merge when green.

**T2 · Phase 4 item 6, the documents.**
1. [`../plans/phase-4.md`](../plans/phase-4.md) item 6 — what it asks.
2. [`../../dev/ARCHITECTURE.md`](../../dev/ARCHITECTURE.md#the-store) — where a new store fact goes. Missing
   today: batches and their id (`src/store/sqlite/batches.ts:48`, `:65`), how an answer is checked
   (`:187`), the `conversations.links` permission (`src/sends/permissions.ts:81`, `:248`), and the
   choice order (`src/conversations/link.ts:116`).
3. [`../plans/phase-4.md`](../plans/phase-4.md) item 6's line — mark what is done, as items 1–5 are.

**T3 · Phase 4 item 5, the by-hand half: the IRC dev split with a real agent.**
1. [`../../../bench/disentangle/README.md`](../../../bench/disentangle/README.md) — how the corpus is
   fetched (`run.sh`, `DISENTANGLE_DATA`) and scored.
2. `src/conversations/agent-loop.test.ts` — the scripted loop to copy: build, `batches next`, answer,
   `links add`, build.
3. `skills/link-conversations/SKILL.md` — what the real agent is told to do; give it that file.

The result is link F1 against the rules alone, numbers only, written into the bench README.

## 4. What will bite

- **One release a day.** `bin/release` refuses within 24 hours of the last one. `Unreleased` already
  holds other sessions' changes, one of them breaking, so `--blocked` would ship them too.
- **A rebase slides changelog lines under a release made meanwhile.** It happened twice on 2026-10-01
  (#327 fixed one). The release workflow builds `main` as it is when the run starts, so check with
  `gh run list --workflow release.yml` which commit a version holds before deciding where an entry goes.
  After every rebase: `git diff origin/main -- CHANGELOG.md`, and every added line above the first
  `## <version>`.
- **`main` moves every few minutes.** Rebase, run the checks, push, and merge as soon as CI is green;
  a second rebase is normal.
- **A new command needs a row in `parity.json`**, or tg-cli's `pnpm parity:check` fails, and tg-cli's
  pre-push hook runs that check. 0.96.0 shipped `store reindex` without one (fixed by #342, unreleased).
- **tg-cli's test matrix** (`pnpm test:matrix`) wants every command and option run through tg's own
  program in a test — `src/archive.test.ts` is where the conversation ones are.
- **Nothing awaits inside a transaction** (phase 1 D3). `replaceConversations` is several transactions
  on purpose and pauses only between them (`src/store/sqlite/conversations.ts:86`); keep it so.
- **An MCP tool may not import from `src/cli/`** (Biome); time parsing is `src/services/moment.ts`.
  Options that take a time end in `-time` (`--since-time`).
- **zsh** does not split `$var` into words, and `$var:x` is a modifier — quote paths, avoid `set -- $pair`.
- **max-cli is the owner's real personal account.** Nothing here touches it; max gets phases 3–4 with
  its move onto `messages.db` (max-cli `docs_ai/plans/2026-10-01-max-reads-onto-store.md`, work item 4
  — mount `conversationsCommand`, one line in its SKILL.md). Another session owns that move.

## 5. Do not read, do not touch

- Phase 2's files — the word index, `src/store/sqlite/search*`, `store reindex`: another session builds it.
- max-cli's code and its move onto `messages.db`: another session owns it.
- `docs/storage/requirements.md` — the owner's words, verbatim.
- PGlite and `research/` — ruled out.
- The 1M benchmark corpus in `~/.cache/cli-messaging/searchbench/` — keep it; regenerating costs 21 s,
  and it is shared by every worktree.

## Decisions you will make — make them knowingly

- T3: which model plays the agent, and the batch size; say both next to the numbers.
- T2: whether the batch id format belongs in ARCHITECTURE or only in the plan.

## How to check

```sh
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm docs:check          # cli-messaging
pnpm build && pnpm check:dist && pnpm smoke:bun
pnpm lint && pnpm typecheck && pnpm test && pnpm test:matrix && pnpm parity:check   # tg-cli, after the bump
```
