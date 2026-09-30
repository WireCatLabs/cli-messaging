# Handoff — lane B: the store's maintenance commands (info, check, migrate, backup, restore)

Phase 1 items 9 and 10 of [`../plans/phase-1.md`](../plans/phase-1.md). **Correction 2026-09-30: built** —
#199 (`store info`, `check`, `migrate`) and #205 (`store backup`, `restore`), released in 0.67.0.
Lanes A and C run at the same time ([`README.md`](README.md)); this lane adds new command files and
does not edit `src/store/store.ts`.

## 1. What this is

`@leemour/cli-messaging` is the shared half of tg-cli and max-cli. `messages.db` is one SQLite file
shared by both CLIs and every account (`storePath()`, `MESSAGING_STORE` overrides it). It is the
owner's system of record: forward-only migrations, no command ever deletes it. This lane gives the
owner the commands to look after it: what it is, whether it is healthy, finishing a migration's
backfill, and a backup they can restore. Full picture: [`../README.md`](../README.md).

## 2. Entry points

| What | Where |
|---|---|
| The plan: items 9–10, decision D10 | [`../plans/phase-1.md`](../plans/phase-1.md) §3 D6, D10; §5 items 9–10; §6 "Commands" |
| The owner's words on backup and doctor | [`../requirements.md`](../requirements.md) §24, §25 |
| How shared commands are built and named | [`../../dev/ARCHITECTURE.md`](../../dev/ARCHITECTURE.md), the CHANGELOG's 0.57.0 naming entry ("a noun, then a verb") |
| Repository rules | [`../../dev/CONVENTIONS.md`](../../dev/CONVENTIONS.md), [`../../dev/TESTING.md`](../../dev/TESTING.md) |
| Trail (optional, private) | max-cli `docs_ai/journal/2026-09-3*-storage-phase-1.md` — grep, do not read through |

## 3. Read for this task, in this order

1. `src/cli/messenger/archive-commands.ts:9` — `storeCommand`, the `store` group
   (`status|fetch|jobs|export`). Answers: where your subcommands go and how a group is built.
2. `src/cli/messenger/doctor-command.ts:153-180` — `storeState`, reading the file **without
   migrating**. Answers: how to open the store read-only, and the summary `doctor` keeps.
3. `src/store/migrations.ts` (`migrate`, `MIGRATIONS`) and `src/store/sqlite/backfill.ts`
   (`pendingNormalization`, `backfillNormalized`). Answers: what `migrate` runs and what the backfill
   fills, in batches, restartable.
4. `src/cli/messenger/serve-command.ts:20-60` and `server-command.ts:320-350` — `lockPath`,
   `readLock`, `alive`. Answers: how to tell a `serve` is running.
5. `src/store/open.ts`, `src/store/driver.ts` — `openCache` and the `PRAGMAS` (WAL, `busy_timeout`
   5 s). Answers: what a connection looks like.

## 4. What will bite you

- **Naming.** The plan says `db info|doctor|migrate|backup|restore`, written before the naming standard
  (0.57.0: a noun, then a verb) and before the `store` group existed. Two groups for one file would
  confuse. Recommended: `store info`, `store check`, `store migrate`, `store backup <file>`,
  `store restore <file>` inside `storeCommand`. Say which you chose, and why, in the PR.
- **The file is shared by two apps.** `serve`'s lock is per app and per profile
  (`lockPath(app, profile, env)`), under each app's own state directory. `tg store restore` must also
  refuse while **max** serves, and the reverse — it cannot find the other app's lock by its own paths.
  Decide how (for example: refuse while any process holds a write transaction, and always print that
  every long-running `serve`/`mcp` must be restarted, as plan item 10 says). This is the hard part.
- **In WAL mode SQLite cannot tell you another process has the file open** — `EXCLUSIVE` acts like
  `IMMEDIATE` (SQLite docs). Hold `BEGIN IMMEDIATE` while you check, and say on stderr what you cannot
  know.
- **Never delete the owner's file.** `restore` renames the live file to
  `messages.db.before-restore-<time>` and moves the backup in; `backup` refuses to overwrite and creates
  its file mode 0600. The `-wal` and `-shm` beside the live file matter: checkpoint first.
- **`VACUUM INTO`** makes the backup (docs say it works under WAL with readers and writers present).
  The copy has the store's current schema; `restore` must refuse a backup this build cannot write
  (`min_compatible` above its version) with today's «… — upgrade this tool» message.
- **`store check` reports, it never repairs**: `PRAGMA quick_check`, `PRAGMA foreign_key_check`, FTS5
  `integrity-check` on `messages_fts`, `chats_fts`, `identities_fts`, free disk against the file size,
  rows waiting for normalization — **and completeness per chat** (NEED-399 A, in
  [`../decisions.md`](../decisions.md)): chats whose held history does not reach their newest message
  (`sync_ranges` against `chats.last_message_at`), and how long ago each was refreshed. §24's "extensions" and "enrichment consistency" do not apply to SQLite yet — say so
  in the output.
- **`store migrate`** applies pending migrations, then runs `backfillNormalized` with a progress line on
  **stderr**; offer `store backup` first (§25 step 1). A migration never runs inside `store info` or
  `store check` — they read without migrating, as `doctor` does.
- **Machine mode**: stdout carries one JSON value and nothing else; progress and notes go to stderr.
  A test checks it.
- `pendingNormalization` and `backfillNormalized` are not exported from `src/store/index.ts` yet — export
  them there; do not touch `store.ts`.
- **Both CLIs must add the command.** A new subcommand inside `storeCommand` arrives by itself with the
  package bump. After the release, bump the pin in tg-cli and max-cli (the owner allows these PRs).
  **Correction 2026-09-30:** true for tg-cli only. max-cli does not use `storeCommand`: its `max store`
  is its own group over the profile cache (max-cli `src/commands/store.ts`), so the commands do not
  reach `max` with the bump. Where they go in max-cli is an open question to the owner (NEED-445).

## 5. Do not read, do not touch

- `src/store/store.ts` and `src/store/sqlite/*` except `backfill.ts` — lane A is rewriting them.
- The migrations and `drizzle/` — no schema change in this lane.
- `docs/dev/ARCHITECTURE.md` "Migrations", `docs/storage/decisions.md` — lane C's.
- The owner's real store (`~/.local/share/cli-messaging/messages.db`): tests use the sandbox
  (`src/testing/sandbox.ts` sets `MESSAGING_STORE`); a manual try uses `MESSAGING_STORE=<tmp>`.

## Decisions you will make — make them knowingly

- The command names (§4, first bullet).
- How `restore` detects the other app's `serve` (§4, second bullet).
- Whether `store migrate` asks before backing up or only suggests it (§25 says "offers").

## How you work

Two PRs, each based on `main`, never stacked: (1) `store info`, `store check`, `store migrate`;
(2) `store backup`, `store restore`. Tests as plan §6 "Commands": the backup opens with equal counts and
mode 0600; `restore` refuses while another connection holds a write transaction and keeps the old
file; `store check` reports a corrupted FTS index (make one by writing to the content table with the
triggers dropped); machine mode prints only JSON on stdout. CHANGELOG under `## Unreleased`, README's
`./cli` line if the command list changes. Merge when every CI check passed; release with `bin/release`
(run it again if another session took the number); then the tg-cli and max-cli bumps.

## How to check

```sh
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm docs:check && pnpm smoke:bun
pnpm build && pnpm check:dist
```
