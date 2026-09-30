# Phase 1 — Drizzle, an async store, the §4–§5 schema, maintenance commands

Plan, 2026-09-29. **Approved by the owner 2026-09-30** (NEED-382 A). Nothing here is built yet. It follows [`../decisions.md`](../decisions.md):
SQLite FTS5 behind an async store interface, Drizzle, no daemon that owns the database, background
workers later. Requirements §30 phase 1 without the PGlite parts: Drizzle integration, async store,
schema per §4–§5, migrations, migration of existing data, repository layer, backup and doctor.

Evidence labels, as in the rest of this folder: **verified** means I read the code or ran it, and
each such claim has a `path:line` at `e796dd2` or a command. **Docs say** means the documentation
says it. **Inferred** means reasoning.

## 1. Goal

At the end of phase 1:

- `MessageStore` is async. Every method returns a `Promise`. No Drizzle or SQLite type crosses the
  interface, so a Postgres backend can implement it later.
- The SQLite backend reads and writes through Drizzle (`drizzle-orm` 1.0.0-rc.4, pinned). FTS5 and
  triggers stay in hand-written SQL.
- Schema changes come from `drizzle-kit generate`. They are applied by our own runner, which keeps
  today's guarantees: one migration under `BEGIN IMMEDIATE`, and `min_compatible` for older CLIs.
- The schema carries what §4–§5 ask for and does not have yet: `normalized_text` and its normalizer
  version, `membership_state`, `is_searchable`, and a chat's message count.
- Existing `messages.db` files upgrade in place. Every tg-cli and max-cli build already installed
  keeps working on the upgraded file.
- `db info`, `db doctor`, `db backup`, `db restore` and `db migrate` exist.
- Search behaves as it does today (§30: "no search changes yet"). It is still trigram over `text`.

## 2. Current state

**The interface is synchronous.** `MessageStore` has 16 synchronous methods
(`src/store/store.ts:66-106`). Only `openStore` is async (`:128-141`). Transactions are
`BEGIN IMMEDIATE` around a synchronous body (`:148-157`).

**All SQL is hand-written.** One SQLite-only construct is `INSERT OR IGNORE` (`:225`). Search is
`m.pk IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)` (`:428`), newest first, with no
ranking. `wordsOf` quotes each word of three letters or more (`:790-795`).
Two doc comments are stacked on `wordsOf` (`:786-790`); the first one is stale (it describes the
prefix search from version 3).

**The driver seam** (`src/store/driver.ts:16-29`) is synchronous: `exec`, `prepare`, `close`.
`openCache` picks `node:sqlite` or `bun:sqlite` by dynamic import (`src/store/open.ts:14-28`).
tg-cli uses this seam for its own storage: `import { type CacheDatabase, openCache, type SqlValue }`
at tg-cli `src/telegram/storage.ts:1`. **The seam stays exported.**

**Migrations are append-only**, and the rule is written down (`src/store/migrations.ts:11-20`): no
`DROP` or rebuild of a base table; a new column is nullable or has a default; every `INSERT` names
its columns. Five versions exist (`:21-271`). Version 5 went back to trigram for message text
because the owner ruled substring search (`:251-257`). The log is `schema_migrations(version,
min_compatible, applied_at)` (`:273-277`). `migrate` runs under `BEGIN IMMEDIATE` and refuses a file
whose `min_compatible` is above its own version (`:292-320`).

**The schema already separates internal ids from provider ids.** Every table has an
`INTEGER PRIMARY KEY pk` and a provider `native_id TEXT`, unique per account or per chat
(`migrations.ts:26-33`, `:80-92`, `:97-119`). §4's "do not use provider ids as primary keys" holds
today.

**Who opens the store** (verified):

| Caller | Where | Note for the async change |
|---|---|---|
| `withStore`, per offline command | `src/cli/messenger/context.ts:123-138` | `return work(store, account)` at `:135` inside `try/finally { store.close() }` — closes early once `work` is async |
| lazy store per connection | `src/cli/messenger/context.ts:80` | long-running under `serve` and `mcp` |
| backfill | `src/cli/messenger/backfill-command.ts:34` | |
| completion, only if the file exists | `src/cli/messenger/complete-command.ts:55` | |
| doctor, reads without migrating | `src/cli/messenger/doctor-command.ts:63-89` | reads `schema_migrations` itself |
| max-cli bot, `quietly` and `fromStore` | max-cli `src/bot/keep.ts:37-47`, `:102-110` | same early-close pattern at `:41` and `:110`; 9 callers |

There are 9 `withStore(` call sites in cli-messaging (`src/cli/messenger/*`, `src/mcp/*`).
max-cli's ~83 synchronous uses belong to its **own** profile cache (`src/cache/store.ts`). That cache
folds in later (§8), not in this phase.

**Versions on the shared file.** max-cli `main` pins cli-messaging 0.29.0 (max-cli
`package.json:84`). tg-cli pins 0.27.0 (tg-cli `package.json:44`). What matters for compatibility
is every build installed on a machine, not what `main` pins. Every version since schema 1 must keep
working, and all of them read only `schema_migrations`.

**Maintenance commands (§24).** Only the messenger `doctor` exists. It reports the store's path,
schema version, the version it speaks, whether it can write, and chat and message counts. It reads
the file without migrating it (`doctor-command.ts:62-89`). `db info`, `db doctor`, `db backup`,
`db restore` and `db migrate` do not exist. `max backup` downloads chat history into max-cli's
profile cache. It does not copy a database file.

**Drizzle 1.0.0-rc.4** (verified in a scratchpad install; `npm view drizzle-orm dist-tags` on
2026-09-29 still has `rc: 1.0.0-rc.4`; the `rc5` tag is a branch snapshot, `1.0.0-rc.5-5935859`):

- `drizzle-orm/node-sqlite` and `drizzle-orm/bun-sqlite` both work over an existing client. Both
  return `{ changes, lastInsertRowid }` from `.run()`, on Node 24.19 and Bun 1.3.14.
  `node-sqlite/driver.js:7` imports `node:sqlite` at top level, so the driver is loaded by dynamic
  `import()`, as `open.ts` does today.
- `db.transaction(async () => …)` is accepted at runtime and not awaited. With a synchronous driver,
  the transaction commits before the awaited part runs. The types reject it
  (`research/2026-09-29-drizzle.md`).
- **The Drizzle migrator is not safe for two processes and does not know `min_compatible`.**
  `migrateSync` (`sqlite-core/async/session.js:177-215`) creates the log table and reads it before
  it opens its transaction. That transaction is a plain `BEGIN`, not `BEGIN IMMEDIATE`. So two
  processes that open an old file together can both decide to apply the same migration.
  `getMigrationsToRun` (`migrator.utils.js`) ignores migrations in the file that it does not know,
  so it never refuses a newer file. The `node-sqlite` migrator only reads a folder
  (`node-sqlite/migrator.js`).
- **`drizzle-kit generate` breaks the append-only rule without a warning.** Adding a nullable
  column, or a column with a default, gives `ALTER TABLE … ADD`. Making `title` `NOT NULL DEFAULT ''`
  gives `__new_chats`, `INSERT … SELECT`, `DROP TABLE chats`, `RENAME`. On `messages`, that drop
  would also drop the FTS triggers. The generated `PRAGMA foreign_keys=OFF` does nothing inside a
  transaction (SQLite docs say so).
- `drizzle-kit generate` writes `drizzle/<timestamp>_<name>/migration.sql` plus `snapshot.json`.
  `--custom` gives an empty `migration.sql` for hand-written SQL.

**Normalization** (verified with Node): the fixture's normalizer (`bench/search/common.ts:23-29`:
NFKD, strip marks, NFC, lowercase) turns `счёт` into `счет`, `Йогурт` into `иогурт`, `València` into
`valencia`, `ﬁle ①` into `file 1`. FTS5 `unicode61 remove_diacritics 2` alone does not fold ё or й:
`счет` does not match `счёт`, `иогурт` does not match `йогурт`. Folding also merges real words:
`мой` and `мои`, `año` and `ano`. That is the price of the ruling. The original `text` is kept.

## 3. Decisions made here

**D1 · One migration runner, ours. Drizzle generates the SQL.**
`drizzle-kit generate` writes each migration into `drizzle/` at the repository root. A small script
bundles them into `src/store/sqlite/migrations.generated.ts`, a list of `{ name, statements }`. A
test fails when the bundle and the folders differ. Each generated migration gets an explicit
`{ version, minCompatible }` in a hand-kept manifest next to the bundle, starting at version 6.
Why: the Drizzle migrator lacks the two guarantees above. The runner is today's `migrate`, which
already provides them. A bundle in TypeScript ships in `dist` like all other code. It works on both
runtimes with no `fs` path to resolve, and `tsc` does not copy `.sql` files.

**D2 · The bridge from `schema_migrations` to Drizzle's log: none. `schema_migrations` stays the only log.**
Versions 1–5 stay in `migrations.ts`, frozen. New files and old files both go through them, then
through the generated migrations from version 6 on. Each applied migration appends a
`schema_migrations` row with its `min_compatible`. `__drizzle_migrations` is never written.
Why: every build already installed decides by `schema_migrations`, so that log cannot go away. A
second log would only be read by `drizzle-kit migrate`, which we do not run against user files, and
two logs can disagree.
Drizzle still needs a baseline to diff against. The first `generate` produces a baseline migration
from a Drizzle schema that mirrors version 5. That migration is recorded in the manifest as "already
covered by versions 1–5" and is never applied. A test checks that the baseline is accurate (§5).
The alternative was to write `__drizzle_migrations` in Drizzle's format so the kit sees a log. I
rejected it: it adds state that nothing reads.

**D3 · Async interface, synchronous transactions inside the SQLite backend.**
Each `MessageStore` method is one whole operation. In the SQLite backend it runs as one synchronous
`db.transaction(fn, { behavior: "immediate" })` wrapped in an `async` function. There is never an
`await` inside a transaction, and the interface has no `transaction(callback)`.
Why: the driver is synchronous, so an awaited step inside a transaction would commit early (see §2).
Because each method body runs to completion without yielding, two concurrent calls on one store in a
long-running `serve` or `mcp` process cannot interleave inside one `BEGIN`.
The cost: a large write blocks the event loop while it runs. Writes stay in bounded batches. A
worker thread behind the same interface is possible later, and callers would not change.

**D4 · Layout.**
`src/store/store.ts` keeps the `MessageStore` interface and domain types only.
`src/store/sqlite/` holds `schema.ts` (Drizzle tables, without FTS), `open.ts` (runtime pick and
PRAGMAs), `migrations.generated.ts` and the manifest, and one module per aggregate: `accounts`,
`chats`, `messages`, `identities`, `ranges`. `openStore` still returns the SQLite store.
`openCache`, `CacheDatabase`, `SqlValue`, `PRAGMAS`, `MIGRATIONS` and `migrate` stay exported:
tg-cli uses the seam, and `MIGRATIONS` is public.
A Postgres backend later is `src/store/postgres/`, with its own schema file. Drizzle has no shared
schema across dialects (`research/2026-09-29-drizzle.md`).

**D5 · §4–§5 map onto the existing columns. Nothing is renamed.**
A rename is a table rebuild, and the rebuild breaks installed builds (`migrations.ts:11-20`). The
table in §4 lists each field. I will add the naming deviations to `decisions.md` when this plan is
approved.

**D6 · Version 6 locks older builds out (owner, 2026-09-30: Q1 B — «we need to make sure the stuff
is in sync and force upgrade of clis»).**

- Version 6 has `min_compatible` 6. Every tg and max build older than it refuses the file with
  today's message — «the message store was written by a newer version … — upgrade this tool»
  (`migrations.ts:301-306`) — so no old build ever writes a row without `normalized_text`. The
  published builds' refusal is checked by test, not assumed (§6, "Installed builds").
- It is a major release of cli-messaging, and **tg-cli and max-cli ship their bump the same day**.
  The release that carries version 6 names the upgrade command for both CLIs in its changelog.
- `normalized_text` and `normalizer_version` are filled by the store on every write. Rows written
  before version 6 are filled once, by a backfill in batches by `pk` range, one short transaction per
  batch, restartable at any point. It runs from `db migrate`, and from the first open when the file
  is small enough (item 6 measures the limit); a larger file prints the `db migrate` command and
  keeps working, search falling back to the raw text for rows not yet filled.
- `chats.message_count` is kept by triggers on insert, tombstone, un-tombstone and delete, and filled
  once for existing rows per chat as an absolute count.
- No trigger for stale normalized copies: only version-6 builds write.

Why the count: phase 2 must choose per query how a filter reaches the index. It needs the size of
the filtered chat for that, cheaply (§7).

**D7 · The normalizer.** It is a pure function in `src/store/normalize.ts`:

- NFKD, strip combining marks, NFC, lowercase;
- replace control characters with spaces, collapse whitespace, trim;
- `NORMALIZER_VERSION = 1`.

This is the fixture's function plus the whitespace and control-character steps from §6. ё→е and й→и
fall out of the mark stripping, so they need no special case. In phase 1 it only fills the column.
The index that uses it is phase 2.

**D8 · max-cli's extra tables become generic tables, not max-only ones.** The rule: a table or column
is generic if Telegram has the same concept. Otherwise it goes into `provider_metadata`. There are
no max-only tables. The mapping is in §8. Nothing is built for it in phase 1. It only has to stay
possible, and every item is an additive migration.

**D9 · How filters reach the full-text index: phase 2 decides per query. Phase 1 only keeps what
that choice needs.**
The FTS index is derived and can be rebuilt (§29.2), so phase 1's schema does not depend on this
choice. I measured one candidate with the fixture, to give phase 2 a head start. Setup: Node 24,
1M messages, no date filter. Each message gets a second FTS column, `scope`, holding `c<chat>` and
`s<sender>` tokens. The query becomes
`{normalized_text} : (…) AND scope : c<chat>`, compared with today's `CROSS JOIN` then filter.
Results, p95 in ms:

| query | filter | `CROSS JOIN` then filter | scope token |
|---|---|---|---|
| 2 common words, every word | small chat (2k) | 15.9 | 4.6 |
| 2 common words, every word | sender (3.8k) | 16.5 | 5.1 |
| 2 common words, any word | small chat | 99 | 5.1 |
| 2 common words, any word | sender | 102 | 5.8 |
| 2 rare words, every word | big chat (500k) | 1.2 | 10.3 |
| 2 common words, every word | big chat | 27.7 | 32.1 |

The index data grew from 95 MB to 107 MB. So scope tokens help a small scope a lot and hurt a big
one. The choice needs the chat's size, which is why D6 keeps `message_count`. I think the effect
grows in a 10M corpus, where today's plan still scores every match in the corpus; that is inferred,
not measured. The script is in this PR's description, not in the repository.

**D10 · Where the `db` commands live.** They go in the shared command set (`src/cli/messenger/`), so
`tg db …` and `max db …` both get them. They act on `messages.db` only. `max cache` keeps max-cli's
profile file until the fold-in.

## 4. §4–§5 against the schema

| Requirement | Today | Phase 1 |
|---|---|---|
| messages.id | `pk INTEGER` | kept |
| source | `accounts.provider`, through `account_pk` | kept; a join with a small table |
| source_message_id | `native_id` | kept |
| account_id, chat_id, sender_id | `account_pk`, `chat_pk`, `sender_identity_pk` (+ `sender_chat_native_id`) | kept |
| sent_at, text | `sent_at` (ms), `text` | kept |
| normalized_text | — | **new**, with `normalizer_version` (D6, §28) |
| reply_to_message_id | `reply_to_native_id` (provider id) | kept; linking to an internal row is phase 3's `message_edges` |
| quoted_message_id, topic_id | — (`thread_native_id` exists) | not added; phase 3 |
| forward_source | `forward` (JSON) | kept |
| created_at / updated_at | `ingested_at`, `edited_at` | kept; a row `updated_at` waits until phase 3's incremental work needs it |
| raw_metadata | `provider_metadata` | kept under its name (D5) |
| chats.id, source_chat_id | `pk`, `native_id` | kept |
| name, type | `title`, `kind` | kept |
| username | — | **new**, nullable |
| membership_state | — | **new**, nullable; `NULL` means unknown; values as §5 lists |
| is_searchable | — | **new**, `NOT NULL DEFAULT 1`; search honours it in phase 2 |
| message_count | — | **new**, `NOT NULL DEFAULT 0`, kept by triggers (D6) |
| first_message_at, last_message_at | `last_message_at` is the provider's value | not stored: `min`/`max` over `messages_by_time (chat_pk, sent_at)` is an index lookup |
| last_indexed_at | — | phase 2, with the index it describes |

Filling `membership_state` needs a field on the domain `Chat` and adapter support in each CLI. Phase 1
adds the optional field and the column. The adapters fill it when they can.

## 5. Work items

Each item is one pull request based on `main`, never stacked. Each merges on its own with
`pnpm lint && pnpm typecheck && pnpm test` green and the Bun smoke passing (`pnpm smoke:bun`).
Releases go through `bin/release` after items 2, 6 and 8, plus whenever tg-cli asks.

1. **Normalizer.** `src/store/normalize.ts` and its tests (§6). Not wired to anything yet.
2. **Async `MessageStore` over today's SQL.** Every method returns a `Promise`. The callbacks of
   `withStore`, the MCP `stored` handlers and the lazy connection store become async and use
   `return await` (`context.ts:135`). Internals stay the hand-written SQL. Release; this breaks the
   API.
3. **Drizzle in, with no behaviour change.** Pin `drizzle-orm` and `drizzle-kit` to `1.0.0-rc.4`
   exactly. Add `src/store/sqlite/schema.ts` mirroring version 5 (FTS tables and triggers left out),
   `drizzle.config.ts`, and the baseline generation. Add the baseline-accuracy test from §6. Load the
   drivers by dynamic `import()`. Acceptance adds a run on Node 22: `engines` says `>=22`, CI runs
   only Node 24 (`.github/workflows/ci.yml:16`), and the drivers were tried only on 24.
4. **Migration runner over generated migrations.** Add the bundle script, `migrations.generated.ts`,
   the manifest, and `migrate` extended to run the frozen 1–5 then the manifest. Add the migration
   guard tests from §6.
5. **Fixture on the real schema.** Add a `store` mode to `bench/search` that loads the corpus through
   `openStore` and `saveMessages` into a real version 5 file. The fixture's own schema is not the
   store's, so nothing in phase 1 can be measured without this loader. Make `DATA_DIR` default to a
   directory under the OS temp folder instead of one session's path (`bench/search/common.ts:5-7`).
6. **Schema version 6, `min_compatible` 6.** Add the new columns from §4 and the `message_count`
   triggers. It is one generated migration plus one `--custom` migration for the triggers. Writes fill
   `normalized_text`. The backfill function exists and is tested; item 9 wires it to `db migrate`. A
   major release of cli-messaging, released together with tg-cli and max-cli (D6).
   **Acceptance, before release:** run the version 5 → 6 upgrade on the 1M file from item 5. Version
   6 is frozen once it is released, so this cannot wait. The one statement that reads every message
   under `BEGIN IMMEDIATE` is the `message_count` fill: `deleted_at` is not in `messages_by_time`.
   If it holds the write lock for more than 1 s at 1M, it leaves the migration and runs per chat from
   `db migrate`. The target is 10M, and other processes wait at most `busy_timeout` (5 s). Release.
7. **Repository layer in Drizzle, writes.** `saveAccount`, `saveChats`, `saveMessages`,
   `savePeople`, `saveReactions`, `markDeleted` and `markRange` are ported, module by module.
   Upserts that use `coalesce` stay `sql` fragments.
8. **Repository layer in Drizzle, reads and search.** `chats`, `messages`, `around`, `message`,
   `find`/`search`, `people`, `chatStats` and `ranges` are ported. `MATCH` stays in `sql`. Add the
   `EXPLAIN QUERY PLAN` test (§6) and the store-against-raw timing (§6). Remove the stale doc comment
   at `store.ts:786-789`. Release.
9. **`db info`, `db doctor`, `db migrate`.** **Correction 2026-09-30:** built as `store info`, `store check` and
   `store migrate`, inside the existing `store` group — the naming standard (0.57.0) puts the noun
   first, and two groups for one file would confuse. `db backup`/`db restore` become `store backup`
   and `store restore` the same way. `db migrate` applies pending migrations and runs the
   backfill with a progress line on stderr. `db doctor` checks:
   - that the file opens;
   - the schema version, and whether this build can write to it;
   - `PRAGMA quick_check`;
   - FTS5 `integrity-check` on the three indexes;
   - free disk space against the file size;
   - rows waiting for normalization.
   - `PRAGMA foreign_key_check`: a file written with foreign keys off (by an older build or by hand);
   - per chat, whether the held history reaches the chat's newest message (`chats.last_message_at`
     against the newest message held), and how long ago the chat was refreshed. This is what lets a
     user tell "nothing was said" from "not fetched" (added 2026-09-30, NEED-399 A).

   §24's "extensions" and "enrichment consistency" do not apply to SQLite in phase 1 and are
   reported as such. The existing `doctor` keeps its short store summary.
10. **`db backup` and `db restore`.** `backup` runs `VACUUM INTO <file>` (docs say it works under WAL
    with readers and writers present). It creates the file mode 0600, and it refuses to overwrite a
    file. `restore <file>`:
    - opens the backup and checks that it opens and has a schema this build can write;
    - holds `BEGIN IMMEDIATE` on the live file, and refuses if a write is in progress;
    - refuses while `tg serve` holds its lock file, or while a `max serve` socket answers;
    - renames the live file to `messages.db.before-restore-<time>`, then moves the backup into place.

    It never deletes the old file (§25). In WAL mode, SQLite cannot show whether another process
    only has the file open: the docs say `EXCLUSIVE` acts like `IMMEDIATE` there. So `restore` also
    says, on stderr, that any `mcp` or other long-running process must be restarted.
11. **Documentation.** `docs/dev/ARCHITECTURE.md` gets the store and the migration rules. Add the
    "how to add a migration" steps: generate, review for rebuilds, add a manifest row, bundle.
    `decisions.md` gets D5's deviations and the answers to §9.

Adoption, in the other repositories after the matching release:

- **tg-cli:** bump the pin. Its own code imports only the seam (`openCache`, `CacheDatabase`,
  `SqlValue`) and `storePath`, and those do not change. The shared commands arrive async with the
  package. Run its suite, and a live `--offline` read.
- **max-cli:** bump the pin. `quietly` and `fromStore` (`src/bot/keep.ts:37-47`, `:102-110`) take
  async callbacks and `await` them, and so do their 9 callers and `src/commands/bot-people.ts`. The
  profile cache is not touched.

## 6. Test plan

**Normalizer:**

- `счёт` → `счет`, `Йогурт` → `иогурт`, `València` → `valencia`, `¿Alguien…?` as in §6;
- NFKC forms such as `ﬁ` and `①`;
- control characters, mixed whitespace, text that is already normalized;
- mixed Russian, Spanish and English in one message;
- the same output on Node and Bun (`pnpm smoke:bun`).

**Async store:**

- every existing store test, ported to `await`;
- `Promise.all` of two `saveMessages` on one store gives both batches whole, with no
  "cannot start a transaction within a transaction";
- `withStore` with an async `work` closes the store only after `work` settles.

**Migrations:**

- **Baseline accuracy.** A file built by versions 1–5 and a file built from the Drizzle baseline SQL
  have the same tables, columns, indexes and defaults (`pragma table_info`, `index_list`,
  `index_xinfo`, FTS shadow tables excluded). Without this, the next `generate` diffs against a
  wrong picture.
- **No rebuild.** No migration after version 5 contains `DROP TABLE` or `ALTER … RENAME` on a base
  table, and no added column is `NOT NULL` without a default.
- **Two openers.** Two processes open a version 5 file together; the migration runs once.
- **Old file.** A version 3 file (unicode61 message index) upgrades to 6, and search finds the same
  rows as before.
- **Newer file.** A file whose `min_compatible` is above this build's version is refused, with
  today's message.
- **Installed builds on a new file.** Published `@leemour/cli-messaging@0.13.0` and `0.27.0` are
  installed as aliased dev dependencies. Each opens a version 6 file and is refused with the
  "upgrade this tool" error, and the file is unchanged afterwards.
- **Backfill.** It fills exactly the waiting rows, and it can be stopped after any batch and started
  again.

**Query plan:** the `find` query with text, chat and date filters is checked with
`EXPLAIN QUERY PLAN`. The test fails if `messages_fts` is scanned once per message row, the
`INDEX 0:=M1` shape the benchmark found (`research/2026-09-29-search-benchmark.md`).

**Commands:**

- `db backup` output opens, has equal counts and has mode 0600;
- `db restore` refuses while another connection holds a write transaction, or while a `serve` is
  running, and it keeps the old file;
- `db doctor` reports a corrupted FTS index (made by writing to the content table with the triggers
  dropped);
- machine mode prints only JSON on stdout.

**Fixture (loader from item 5), at 100k and 1M on Node, 100k on Bun:**

- item 6: ingest rate through `saveMessages`, before and after the triggers;
- item 6: the version 6 migration on a 1M file at version 5, with the time the write lock is held.
  Also measure the backfill's time and WAL size, and whether a concurrent reader and writer stay
  under `busy_timeout` (5 s) while it runs;
- item 8: search p95 through the store against `sqlite.ts` on the same queries. Drizzle and async
  must add under 1 ms.

**Bun:** `pnpm smoke:bun` already opens a store, saves a message and searches it
(`scripts/smoke.ts:56-74`). From item 3 on it also exercises Drizzle's `bun-sqlite` driver, and from
item 4 on the new migration runner.

## 7. Migration of existing `messages.db` files

- No copy, no second database, no prompt. §25's migration was SQLite to PGlite, and the engine
  ruling removed it. The file upgrades in place, forward-only, as versions 2–5 did.
- The first new-build process that opens the file applies version 6 under `BEGIN IMMEDIATE`. The
  change is `ALTER TABLE … ADD`, the triggers, and possibly the `message_count` fill (item 6 decides
  by measurement). Other processes wait up to `busy_timeout`.
- **Mixed versions on one file.** The first version-6 build to open the file upgrades it; from then on
  the other CLI, if older, refuses the file and says to upgrade (D6). Nothing old writes to it again.

- **Backup first.** `db migrate` offers `db backup` before a migration (§25 step 1). An automatic
  migration on open does not, because version 6 is additive and cannot lose data (inferred from the
  statements it contains).
- The phase 2 switch to `unicode61` over `normalized_text` is a rebuild of a derived index, so the
  same rules hold.

## 8. max-cli's cache, later

Not in phase 1. Recorded so that phase 1 does not block it.

| max-cli `<profile>.db` | In `messages.db` |
|---|---|
| the profile | an `accounts` row: provider `max`, the owner's user id. Bot rows use provider `max` too (`src/bot/keep.ts:17`), so identities are shared, as the model intends |
| `chats` (+ `generation`, `fetched_at`) | `chats`; `generation` and the list's completeness go into a generic `sync_state` |
| `people` (+ `description`, `last_messaged_at`, `source`) | `identities` (+ generic `description`); recency per account on `account_identities`; `source` in `provider_metadata` |
| `chat_members` | generic `chat_members (chat_pk, identity_pk)` |
| `sync_marker`, `fetched` | generic `sync_state (account_pk, key, value, at)` |
| `fetch_lease` | generic `fetch_leases`; tg-cli's backfill can use it |
| `messages.transcript`, `transcript_model` | on `attachments`, since a transcript belongs to a voice attachment |
| `messages.update_time`, `link` | `edited_at`; `link` into `reply_to`/`forward` or `provider_metadata`, decided in that plan |
| `ranges` by time | `sync_ranges`; its key is "the provider's ordering key", which for MAX is time in ms |
| hard delete (`forget`), `max cache clear` | a store `purge(account)` that deletes rows, with FTS kept by the triggers; tombstones stay the default |

Every row is an additive migration. Nothing in versions 1–6 conflicts. Message ids are unique per
chat, which MAX satisfies. Every row has `account_pk`, which lets `cache clear` forget one profile.
The ~83 synchronous uses in max-cli (`src/resolve.ts`, `src/client.ts`, completion) become `await`
in that phase. **Correction 2026-09-29:** there is no copy — the owner ruled that personal profiles start fresh in
`messages.db` and the old `<profile>.db` files are no longer read (max-cli `DECISIONS.md`, "One store";
NEED-383 put the move on Drizzle, after this phase). Was: the copy from `<profile>.db` is §25's procedure: batches, counts checked, old file
kept.

## 9. Questions for the owner

**Q1 — answered 2026-09-30: B.** Version 6 raises `min_compatible` to 6; older builds refuse the file
and ask to be upgraded; tg-cli and max-cli ship together (D6).

**Q2 — answered 2026-09-30: A.** Keep the substring index over message text next to the word index;
words with BM25 first, substring when words and typo correction find nothing. «I would implement it
and then later, if we see that we don't need it, we can get rid of it.» How each index works:
[`../search-indexes.md`](../search-indexes.md).
