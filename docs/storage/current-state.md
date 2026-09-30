# Storage today — two SQLite stores, three programs, no data server

Read 2026-09-29 at cli-messaging `5dd667f` (0.27.0), max-cli `f5b9929` (0.19.0), tg-cli 0.4.0.
Anchors are `repo: path:line`; they drift, so search for the named function if a line has moved.
**Correction 2026-09-30:** by 2026-09-30 line numbers had moved 2–25 lines; the pins in the table below changed the same day.

**Correction 2026-09-30:** this page is a snapshot of cli-messaging 0.27.0, kept because
[`decisions.md`](decisions.md) cites it as the evidence for the daemon ruling. The store it describes
has changed: for today's store read [ARCHITECTURE "The store"](../dev/ARCHITECTURE.md#the-store) and
`CHANGELOG.md` from 0.49.0 on. The false claims below are struck through where they stand.

## The two stores

**cli-messaging's message store** — one file for every messenger and account:
`MESSAGING_STORE`, else `<XDG state>/cli-messaging/messages.db` (cli-messaging: `src/store/path.ts:8`).

- Exports from `@leemour/cli-messaging/store` (`src/store/index.ts`): `openCache`, `PRAGMAS`,
  `MIGRATIONS`/`migrate`, `storePath`, `openStore`, types `MessageStore`, `AccountKey`, `Range`,
  `StoredHit`, `MessageFilter`, `ChatStats`, `CacheDatabase`.
- ~~**Synchronous API** except `openCache`/`openStore`~~ **Correction 2026-09-30:** every method is
  async since 0.36.0 (`MessageStore` in `src/store/store.ts`), and the list below has grown by
  members, sync state, leases, contacts, transcripts, `applyDelta` and `purge`. Was
  (`src/store/store.ts:64-103`, `:126`):
  `saveAccount`, `saveChats`, `saveMessages`, `chats`, `messages`, `around`, `message`, `markDeleted`,
  `search`, `find`, `savePeople`, `people`, `saveReactions`, `markRange`, `chatStats`, `ranges`.
- Schema (`src/store/migrations.ts`), forward-only with `min_compatible`, in `schema_migrations`
  (`:249`): `accounts`, `persons`, `identities`, `identity_links`, `identity_link_events`, `chats`
  (per account), `messages` (tombstones via `deleted_at`, `reactions`, `provider_metadata`,
  `ingested_via`), `message_revisions`, `attachments`, `sync_ranges`, `account_identities`; three
  FTS5 trigram external-content indexes (`messages_fts`, `chats_fts`, `identities_fts`) kept by 9
  triggers (`:153-187`). **Correction 2026-09-30:** versions 6–11 are Drizzle-generated SQL in
  `drizzle/`, listed in `src/store/sqlite/manifest.ts`; they add the normalized text and message
  counts (6), `chat_members` (7), `sync_state` (8), `fetch_leases` (9), contact recency (10) and
  transcripts (11).
- SQLite-specific: `INSERT OR IGNORE` (`store.ts:223`), FTS5 `MATCH` (`:425`), `BEGIN IMMEDIATE`
  (`:147`). Driver seam `src/store/driver.ts` (sync `exec`/`prepare`/`close`, `run` → `changes`),
  runtime picked between `node:sqlite` and `bun:sqlite` by dynamic import.
- Openers inside the package: `connected()` lazily per connection, `withStore` per offline command — ~~`src/cli/context.ts:80`, `:133`~~ **Correction 2026-09-30:** `src/cli/messenger/context.ts` (`connected` 63, `withStore` 123), backfill (`backfill-command.ts:34`), completion only if
  the file exists (`complete-command.ts:55`), doctor with raw `openCache` (`doctor-command.ts:67`).
- ~~No CHANGELOG~~ **Correction 2026-09-30:** `CHANGELOG.md` exists; released by `bin/release`,
  commits `chore: release x.y.z`.

**max-cli's own cache** — one file per profile, no account column:
`<cache>/max-cli/<profile>.db` (max-cli: `src/cache/index.ts:29`), `PRAGMA user_version = 5`
(`src/cache/schema.ts:7`).

- Tables: `chats` (+ `generation`, `fetched_at`), `people` (+ `description`, `last_messaged_at`,
  `source`), `chat_members`, `sync_marker`, `messages` (+ `update_time`, `attachments` JSON, `link`,
  `transcript`, `transcript_model`), `ranges`, `fetched`, `fetch_lease`; FTS5 trigram on chats,
  people, messages; upgrades drop and rebuild everything but `messages`/`ranges`
  (`src/cache/schema.ts:234-334`).
- `src/cache/store.ts` (717 lines): ~36 plain queries/upserts, 6 FTS5 `MATCH` queries through
  `chatWhere` 193, `peopleWhere` 208, `messages.search` 613; complex: `refreshRecency` 280 (correlated
  subquery), `contacts` 428 (`DISTINCT` over a 3-table join); `BEGIN IMMEDIATE` in `inTransaction`
  307; the lease `claim` 687 decided by `changes === 1`.
- **All synchronous**: ~40 `openProfileCache` calls in ~20 files, ~83 uses read results without
  `await` (e.g. `src/resolve.ts:31`, `src/client.ts:2307`, completion).
- Hard-deletes messages (`forget`); cli-messaging tombstones them.

## Who opens what

| Program | Store | How |
|---|---|---|
| tg-cli 0.4.0 (pins cli-messaging ~~0.25.0~~ ~~0.27.0~~ 0.61.0, Correction 2026-09-30:) | messages.db | every command, `tg serve` and `tg mcp` open it directly (shared command set from `@leemour/cli-messaging/cli`) |
| max-cli 0.19.0 (pins cli-messaging ~~0.13.0~~ ~~0.29.0~~ 0.61.0, Correction 2026-09-30:) | messages.db | bot commands only, `openStore()` per call (max-cli: `src/bot/keep.ts:40,105`) |
| max-cli | `<profile>.db` | every personal-account command (~35 sites), `max serve` (`src/commands/serve.ts:49`), `max mcp` per tool call (`src/mcp/tools.ts:112,231,458`), backup, export, cache clear, completion, doctor |

**tg-cli and max-cli write the same messages.db**, from separate processes and different package
versions (~~max's 0.13~~ ~~an older CLI opens a newer file because `min_compatible` is 1~~
**Correction 2026-09-30:** `min_compatible` is 6 since 0.49.0, so a CLI built before it refuses the
file and asks to be upgraded; the two CLIs upgrade together). SQLite's WAL and `busy_timeout` are
what make that safe today.

## The servers that exist

- **`max serve`** — one per profile, Unix socket `<state>/profiles/<profile>.sock`; framing is one
  lossless-JSON value per line (max-cli: `src/server/lines.ts:11-20`). Requests: `subscribe`,
  `status`, `stop`, `login`, and `{opcode, payload}` forwarded to MAX (`src/server/server.ts:406-436`).
  **A MAX-protocol proxy, not a data API** — no command reads the cache through it. Auto-started
  detached with a 15-minute idle stop (`src/server/start.ts:10,37-72`); a command-started server of
  another version gives way (`start.ts:92-99`). Commands use it only when `serve` is on, there is no
  `MAX_TOKEN`, no `--offline`, and it is not a test (`src/commands/context.ts:149-172`).
- **`tg serve`** — cli-messaging's `serve-command.ts`: one lock file per profile
  (`<state>/serve/<profile>.lock`), **no socket, no request protocol**; started by a person or
  systemd, never auto-started (`docs/plans/2026-09-27-background-process.md` §1).

## What runs without any server today

`--offline` (both CLIs), `max cache clear`, `max store fetch`, `max store export`, `doctor` (reads the schema
version without migrating), shell completion (latency-sensitive), `max mcp`, every bot command
(HTTP Bot API, no socket), `serve` itself as a second writer, and the test suites of all three
repositories, which open stores directly.

## What this means for any "only the daemon opens the database" design

1. A **data protocol** does not exist: every read and write in ~35 max-cli sites and all of
   cli-messaging's commands becomes a call to another process.
2. The owner must be **one process per machine for both CLIs**, with its own start, idle, lock and
   "another version gives way" rules — across two packages released separately.
3. Every path in the previous section needs the daemon started for it, or a fallback.
4. The store API goes **async** (ruled by the owner: fully async, 2026-09-29).
5. max-cli's cache has to fold into cli-messaging's schema: per-profile with no account key;
   **Correction 2026-09-30:** the missing tables are built — versions 7–11 as generic tables, and
   `purge(key)` forgets one account's rows (plan D8,
   [`plans/phase-1-max-tables.md`](plans/phase-1-max-tables.md)); the fold itself is later. Was:
   tables and columns cli-messaging lacks (`chat_members`, `sync_marker`, `fetched`, `fetch_lease`,
   `transcript`, `generation`, recency); hard delete versus tombstones; `max cache clear` must forget
   one profile's rows in a shared store.
