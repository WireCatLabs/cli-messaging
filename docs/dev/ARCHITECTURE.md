# Architecture

What the package is made of and where the seams are. The design and its reasons are in
[the platform proposal](../plans/2026-09-26-platform-proposal.md); this page is the map of what
exists. Written 2026-09-29 against 0.28.0. **Correction 2026-09-30:** the store and migration
sections describe 0.61.0 — the async store, Drizzle and store versions 6–11 came in 0.36.0–0.60.0.

## The one rule

**Nothing here knows a messenger.** A CLI's adapter translates its provider's objects into the
domain types, and `biome.json` refuses any import of `@mtcute/*`, `ws` or an adapter directory
under `src/`. What only one provider has travels in `providerMetadata`. The boundaries are in
[proposal §3](../plans/2026-09-26-platform-proposal.md#3-package-boundaries).

## Modules

| Export | Directory | What it holds |
|---|---|---|
| `.` | `src/domain/`, `src/render/`, `src/resolve.ts`, `src/terminal/` | the domain model (`models.ts`, types only), message locators, message rendering, name resolution that refuses rather than guesses, the secret prompt, the terminal QR code |
| `./store` | `src/store/` | the SQLite seam and the shared message store |
| `./sends` | `src/sends/` | the send guard: read-only, the allow-list, the recipient list, the hourly limit, the journal (never the text), the send id |
| `./services` | `src/services/` | the use cases, once each, that commands and MCP tools call — see [Services](#services) |
| `./background` | `src/background/` | what any background process needs and no messenger: the lock per app and profile, whether a PID is alive and ours, the machine seam tests replace, systemd and launchd units — `serve` and `server` are built on it, each CLI's server stays its own (NEED-492 C) |
| `./cli` | `src/cli/`, `src/mcp/` | the command skeleton, the shared commands and the MCP server |
| `./testing` | `src/kit/` | the adapter kit: a fake adapter, the contract cases and their seed — see [the adapter guide](ADAPTERS.md). `src/testing/` is this repository's own test setup and is not published |

The README's table lists what each export offers; this page does not repeat it.

## The store

`openCache` (`src/store/open.ts`) opens `node:sqlite` under Node and `bun:sqlite` under Bun. Both
imports are dynamic: a static import of the other runtime's module fails at load time, before
anything can catch it. `pnpm smoke:bun` is what proves the Bun half.

Before it opens the file, `openStore` checks once per process that the runtime's SQLite has the
full-text search the migrations need (`assertStoreCapable`), and refuses with what to install. The
version number does not tell: official Node 22.0–22.15 has SQLite 3.46–3.49 without FTS5. CI runs the
built package on Node 22.15.0 to see the refusal (`scripts/check-old-node.mjs`).

Where the runtime's SQLite can be swapped, ours from `@leemour/cli-messaging-sqlite` (built in
`packages/sqlite`, published by `.github/workflows/sqlite.yml`) takes its place
([plan](../storage/plans/sqlite-runtime.md)):

- **Bun on macOS** always loads ours (`bunDatabase`, `src/store/drivers/bun-sqlite.ts`), once, before
  the first database: Bun uses the system's library there, which can be too old.
- **A Linux distribution's Node** links the system's `libsqlite3`. `ensureSqlite`
  (`src/sqlite-runtime.ts`, exported as `@leemour/cli-messaging/sqlite-runtime`) is the first thing
  `tg` and `max` run: when the system's SQLite fails the check above, it starts the command again
  with ours first on `LD_LIBRARY_PATH`, before anything is read or sent. CI runs it on Ubuntu's Node
  with SQLite 3.42 (`scripts/check-sqlite-restart.mjs`).
- Official Node and Bun on Linux and Windows build SQLite in; nothing is swapped.

`openStore` (`src/store/store.ts`) is the **one file for every messenger and account** — tg's
profiles and max-cli's bots write the same database, keyed by provider and account. Its path comes
from `storePath` (`src/store/path.ts`), the only place that turns `MESSAGING_STORE` into a path;
`mcp config` copies the variable into the entry it prints, so the server it starts opens the same file.

Every `MessageStore` method is async and is **one whole operation**: inside the SQLite store each
write runs as one synchronous `BEGIN IMMEDIATE` transaction, with no `await` between `BEGIN` and
`COMMIT`. The interface has no `transaction(callback)`. The driver is synchronous, so an `await` inside a
transaction would let the commit run before the awaited part; and since a method never yields
mid-transaction, two calls on one store in `serve` or `mcp` cannot interleave inside one `BEGIN`
([phase 1 plan, D3](../storage/plans/phase-1.md#3-decisions-made-here)). A large write therefore
blocks the event loop while it runs — keep writes in bounded batches.

**One method is several transactions on purpose:** `replaceConversations` (phase 3). A chat of 1M
messages takes seconds to write, and every other process waits at most 5 s for the lock, so it writes a
new **build** of the chat's links and conversations in transactions of ~250 ms with a 120 ms pause
between them, makes the build current in one more, and drops older builds the same way. Each
transaction runs synchronously to its `COMMIT`; the pause is between them. Readers see only
`conversation_state.current_build`, so a half-written or failed build is never read. Without the pause
the next `BEGIN IMMEDIATE` wins the lock again at once and a waiting process sees no gap
([`bench/disentangle/`](../../bench/disentangle/README.md), plan
[phase 3, C3](../storage/plans/phase-3.md#4-decisions-made-here)).

**The user's agent links what the rules leave open** (phase 4, [plan](../storage/plans/phase-4.md)). The CLI
never calls a model ([NEED-405](../storage/decisions.md)); it hands the agent batches and stores its
answers, in `src/store/sqlite/batches.ts`:

- **A batch** is the earliest live message that needs the agent — no reply the messenger records, no
  current agent answer — and the next `--size` live messages, plus `BATCH_CONTEXT` (50) messages before
  it as context. The rules' current links come along as candidates. No table holds batches.
- **The batch id** (`batchId`) names the chat, the first and last message to answer, and a hash of every
  live message between them. `links add` reads that span again and refuses the answer when the hash
  differs: a message added or deleted inside it means the agent answered a window that moved. Answering
  some of its messages leaves the id valid.
- **An answer is checked whole before anything is stored** (`saveAnswers`): every message one the batch
  asks about, each parent in the batch and earlier than its message, no message twice, confidence 0–1, a
  model named. One refusal stores nothing. A message's new answer replaces its earlier one; the rows are
  `message_links` with `source = 'agent'`, outside any build, so a rebuild keeps them. An answer goes
  stale when its message or parent changes after it was written, and the message needs the agent again.
- **The choice** (`choose`, `src/conversations/link.ts`): the messenger's reply, then a fresh agent
  answer — including "starts a conversation", which drops the rule's parent — then the most confident
  rule. An answer naming a message the chat no longer holds leaves the choice to the rules.
- **Permission**: `conversations links` has its own key, `conversations.links` (`keyForCommand`,
  `src/sends/permissions.ts`), so a profile read-only on messages can still link — the answers write
  only to the local store. `batches next` shows message text and is checked as `messages`.

**Where the queries live.** `src/store/store.ts` holds the `MessageStore` interface and `storeOver`, a
facade that opens the transaction and delegates. The SQL is in `src/store/sqlite/`, one module per kind
of record — `accounts`, `identities`, `chats`, `messages` (writes), `reads`, `search`, `ranges`,
`sync` (state and fetch leases), `transcripts`, `conversations` — as plain functions taking a `StoreContext`: the
connection as the `CacheDatabase` seam and as Drizzle (`orm`), and the clock. Queries are Drizzle's
builder, called synchronously (`.get()`, `.all()`, `.run()`); FTS `MATCH`, `json_extract` and the
`coalesce(excluded.…)` upserts stay `sql` fragments. Use `inTransaction`, never Drizzle's
`transaction`. A statement that runs for every saved message is `.prepare()`d once per store
(`identities.ts`, `messages.ts`): built per call, Drizzle cost about a quarter of the load rate
([results](../../bench/search/results.md#the-real-store-after-the-message-writes-moved-to-drizzle)).
`src/store/search-plan.test.ts` fails if search starts reading the text index once per message.

Opening a store also fills `messages.normalized_text` for rows stored before version 6, when at most
5,000 of them wait (`BACKFILL_ON_OPEN`, about 40 ms); a larger file keeps working and waits for the
maintenance command that fills it in batches.

**Two text indexes.** `messages_fts` (trigram over `text`) answers substring search. `message_words`
(version 12) holds the words of `normalized_text` for ranked search — contentless with delete support,
kept by triggers that fire only when the normalized text, the sender or the chat really changed, with
a `scope` column of `c<chat_pk>` and `s<sender_identity_pk>` tokens. Ask its vocabulary through
`message_words_vocab` with `col = 'normalized_text'`, and restrict a word query to that column, or the
scope tokens come back as words. A file of at most `BACKFILL_ON_OPEN` messages is indexed by the
migration; a larger one records in `search_index_state` the highest `pk` the batches must reach.
`fillSearchIndex` (`src/store/sqlite/search-index.ts`) gets it there in batches of 5,000 — the
normalized text first, then the words, then the typo vocabulary (`search_terms`,
`search_term_trigrams`), then the words of messages stored since — from `store migrate`,
`store reindex`, and up to 200 ms before each
`messages search`. When everything is built it returns without taking the write lock. Nothing ranks
by it yet ([phase 2](../storage/plans/phase-2.md)). The search's steps over it are in
`src/store/sqlite/words.ts`: `matchWords` (every or any word, whole or as beginnings, bm25 then
newest), `matchSubstring`, and `knownTerms` and `termCandidates` for typo correction. A chat or
sender under `SCOPE_TOKEN_LIMIT` messages is filtered inside the index by its scope token, a larger
one by a join; `src/store/search-plan.test.ts` fails if any step reads an index once per message.
`search` (`src/search/search.ts`) runs them in the plan's order — every word topped up by beginnings,
typo correction, any word unless the query chose with OR, substring — each only when the one before
found nothing, and by substring alone until the word index is ready. Its tests are the owner's
scenarios (`docs/storage/search-indexes.md`).

**Drizzle is bundled, not installed.** `drizzle-orm` is a development dependency. `pnpm build` runs
`scripts/bundle-drizzle.ts`, which writes the Drizzle modules the store uses into
`dist/store/sqlite/drizzle/`: loaded from `node_modules`, Drizzle costs Node about 200 ms per
process, bundled about 6 ms. So:

- Import Drizzle only through `src/store/sqlite/drizzle/` — `core.ts` for the query builder and
  schema functions (add a name there when you need one), `node.ts` and `bun.ts` for the drivers.
  Anywhere else, `biome.json` refuses `drizzle-orm` (`noRestrictedImports`, `biome.json:40`); the
  folder itself and tests are exempt (`:84`). A direct import passes the tests and crashes tg and max
  at runtime, where `drizzle-orm` is not installed.
- The Node and Bun drivers are separate bundle entries and are loaded by dynamic `import()`: each
  imports its own runtime's SQLite at the top of its file, so loading one under the other runtime
  fails.
- `scripts/check-dist.ts` refuses a `dist` that still imports `drizzle-orm` and reads a row through
  the bundle. CI runs it under Node (`pnpm check:dist`) and under Bun (`bun scripts/check-dist.ts`).

### Migrations

Versions 1–5 are hand-written in `src/store/migrations.ts` and frozen. From version 6 on, a
migration is SQL that `pnpm db:generate` writes into `drizzle/` from `src/store/sqlite/schema.ts`,
`pnpm db:bundle` copies into `src/store/sqlite/migrations.generated.ts`, and a row in
`src/store/sqlite/manifest.ts` numbers. Our runner (`migrate`) applies both, under `BEGIN IMMEDIATE`;
Drizzle's own migrator is not used. Every migration is forward-only, additive, numbered, and never
edited once it reached anyone's file — a test refuses a generated rebuild of a base table. `min_compatible` lets an older CLI keep using a file a newer
one migrated; only a breaking change raises it, and that is a major version of this package.
**Correction 2026-09-30:** version 6 raised it to 6 (0.49.0), so every build before 0.49.0 refuses
a file a newer build has opened, and asks to be upgraded. Versions 7–11 kept it at 6. The rules are
[proposal §4, Migrations](../plans/2026-09-26-platform-proposal.md#migrations).

⚠ **Announce a migration number before writing it.** Several sessions work in this repository at
once, and two of them taking the same number is a conflict no rebase fixes. The next free number
lives in [the lanes plan §4](../plans/2026-09-29-parity-lanes.md#4-releases-while-lanes-run); take
it by editing that line in a PR of its own, merged before the migration.

#### Adding a migration

1. **Take the number** as the paragraph above says, and wait for that PR to merge.
2. **Change `src/store/sqlite/schema.ts`**, then `pnpm db:generate --name version-<n>-<what>`. It
   writes `drizzle/<timestamp>_version-<n>-<what>/migration.sql`.
3. **Read the SQL before anything else.** For a constraint change (a new `NOT NULL`, a changed
   default, a foreign key), drizzle-kit rebuilds the table: `CREATE TABLE __new_…`, copy, `DROP TABLE`,
   `RENAME`. A build already installed breaks on that, and on `messages` the `DROP` also removes the
   full-text triggers. Choose a change drizzle-kit can express as `ALTER TABLE … ADD` — a new column is
   nullable or has a default — or a new table. The test "never rebuild a base table"
   (`src/store/sqlite/manifest.test.ts:14-19`, `:47`) refuses the rest.
4. **Triggers, FTS5 tables and data fills go in a custom migration**, since `schema.ts` holds neither
   triggers nor FTS: `pnpm db:generate --custom --name version-<n>-<what>`, then write the SQL into
   the empty file. Put `--> statement-breakpoint` between statements — the bundle splits on nothing
   else (`scripts/bundle-migrations.ts:20`), so a trigger body with `;` inside stays whole. Generate
   it right after step 2: folders apply in name order, which is their timestamp.
5. **Add a row to `MANIFEST`** (`src/store/sqlite/manifest.ts`) for each new folder, with the same
   `version`. Two folders with one version — the generated one and its custom one, as version 6 —
   apply as one migration and write one `schema_migrations` row. Versions run on without a gap
   (`manifest.test.ts:38-45`).
6. **`minCompatible` stays where it is** — 6 today — for an additive change. Raising it locks every
   older build out of the file: ask the owner first; it is a major version of this package, and
   tg-cli and max-cli ship their upgrade the same day, as with version 6.
7. **`pnpm db:bundle`** after every `db:generate` and every edit of a `migration.sql`. It rewrites
   `src/store/sqlite/migrations.generated.ts`; `pnpm build` does not, and the test "are bundled
   exactly as drizzle-kit wrote them" (`manifest.test.ts:22`) fails until you run it.
8. **Test that the oldest build that must still open the file does.** The published 0.49.0 is a
   development dependency, `cli-messaging-0.49`; the pattern is "a build on version 6, on a version 7
   file" in `src/store/chat-members.test.ts`. "is what every migration builds"
   (`src/store/sqlite/schema.test.ts:76`) checks that `schema.ts` and the migrations agree.
9. **CHANGELOG**: an entry under `## Unreleased` that names the store version, as "Chat members in
   the store (store version 7)" does.

A migration is frozen once released: fix a mistake with the next version, never by editing a folder.

## The command skeleton

`run()` (`src/cli/program.ts`) never throws; it returns an exit code. It lifts a profile given as
the first word, resolves settings (flag → environment → file → default, `src/cli/settings.ts`),
records runs (`src/cli/runs/`) and closes what a command holds when `--timeout` ends it
(`src/cli/deadline.ts`).

A CLI describes its messenger once — a `Messenger` (`src/cli/messenger/context.ts`) with a
`connect` that returns a `MessengerAdapter` (`src/cli/messenger/port.ts`) — and gets the shared
commands, one file per resource in `src/cli/messenger/`. Two wrappers sit between a command and the
adapter: `observed.ts` times each call into the run record, `stored.ts` saves what was read. A new
adapter method is optional and reached with `capability()`; the wrappers pass through any method
they do not name. How to write an adapter for a new messenger, and test it with the contract cases,
is [the adapter guide](ADAPTERS.md).

The MCP server (`src/mcp/`) holds one connection for minutes and runs one call at a time; each tool
lives in `src/mcp/tools/<resource>.ts` and answers what the command's `--json` prints.

## Services

Five layers, each calling only the ones below it: the **domain** (`src/domain/`), the **adapters**
(each CLI's own, behind `MessengerAdapter`), the **ports** (`port.ts`, the store), the **services**
(`src/services/`) and the **interface** (the commands and the MCP tools). The layer design is in
max-cli's private `docs_ai/plans/2026-09-30-layers.md`; how this package built its half is
[the services plan](../plans/2026-09-30-services.md). `biome.json` refuses an import of `commander` or
of a command file from `src/services/`, `src/sends/` and `src/mcp/`: what a service or an MCP tool
shares with a command lives in the service, and the command imports it.

A service is a plain object made by a factory over `ServiceDeps` (`src/services/deps.ts`): the
messenger, `offline`, and a connection, a store and an account that are each opened on first use —
so a read from the store never connects. `servicesFor(deps)` hands out `messages`, `chats`, `people`,
`inbox` and `archive`. A command gets them from `withServices` on its context, which closes what was
opened; an MCP tool builds them over the session's connection with `onlineDeps`, or over the store
with `storedDeps`. Either way a command and its tool run the same method, and so answer the same
error for the same input. Each caller still parses its own input, so an error names `--since` in a
command and `since` in a tool.

**A messenger that pushes its history reads it from the store.** `Messenger.history: "store"` sets
`ServiceDeps.reads`, and every read that `--offline` answers from the store — `chats list|show`,
`messages list|context`, `contacts list|show` — answers from it for that messenger without
`--offline`, and never connects; writes still do. `serve` keeps the store filled, so such a read
warns on stderr when no `serve` holds the profile, and a chat with nothing stored is `not_found`.
`store fetch`, `inbox` and `review` refuse for now. The MCP chat resource reads the store too; the
MCP tools still go through the session's connection.

**A CLI replaces a use case, not a command.** `Messenger.services` is an `Override`: it gets the
shared services and returns the ones it changes, and can call the shared method inside its own:

```ts
services: (base) => ({
  messages: { ...base.messages, list: (chat, window) => maxList(base.messages, chat, window) },
}),
```

Commands and MCP tools both see the replacement. To add a subcommand, a CLI calls `addCommand` on
the command a factory returns.

Saving what a read answered and timing each call stay decorators on the adapter (`stored.ts`,
`observed.ts`), stacked by `connected()` in `context.ts`, so no service can forget to save.

## Who consumes it

- **tg-cli** — the whole skeleton, the store, the guard and the MCP server; its adapter is under
  its own `src/telegram/`. To try an unreleased change: `bin/try-messaging` in a tg-cli checkout
  beside this one, never a committed `file:` path.
- **max-cli** — for now its bot accounts: the store, the guard and parts of the skeleton. Its
  personal account still keeps its own cache; moving it here is the proposal's Phase 4.

Both pin an exact version; a change here reaches them through a release and a bump in each.
