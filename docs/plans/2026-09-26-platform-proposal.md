# Messaging platform: cli-messaging + tg-cli — proposal

**Status 2026-09-26: proposal, nothing built. Stop for review before Phase 0.**
Answers the brief's §17 (reuse map, extraction map, Telegram adapter, package boundaries, phases,
risks, spike) and adds one section the brief asked for later in the conversation: a store that is
ready for contact linking and cross-messenger context (a CRM) without building the CRM now.

Evidence levels, as in max-cli: **read in the source** (a `path:line`), **the docs describe** (not
run), **inferred** (hedged). Nothing here was run against Telegram yet.

---

## 0. The criterion everything is checked against

> After Telegram, a third messenger costs less — and neither MAX nor Telegram loses a feature to a
> lowest-common-denominator API.

Three consequences:

1. **Two implementations before an abstraction.** Only what already looks the same in MAX and
   Telegram moves into `cli-messaging`. Everything else stays in the adapter and travels as
   `providerMetadata`.
2. **The local store is a system of record, not a cache.** A backfilled group, a link between two
   identities, a note on a person — none of these can be fetched again. This is the single biggest
   difference from max-cli, and it changes the schema, the migration strategy and the file location
   (§4).
3. **The CRM is a schema property, not a feature.** Every message points at a sender identity, every
   identity points at a person, and every message has a stable locator. Notes, tags, follow-ups and
   "what did this person promise" become additive tables later. No CRM command ships now.

---

## 1. Reuse map

### From `@leemour/cli-core` — as is

Everything: streams, renderer (`pretty`/`json`/`jsonl`), closed error codes and exit codes,
keyring and `Credentials`, config loading, paths, logging with redaction, retry, clocks,
`/commands` (introspection), `/completion`, `/update`, `/testing`.

- **`paths.state` is already the XDG *data* directory** (`cli-core/src/paths.ts:35`,
  `state: … ?? base.data`). So the store needs no cli-core change to live outside the cache dir.
- braze-cli is represented by cli-core; nothing further is taken from it.

### From max-cli — copied into `cli-messaging` and generalised

max-cli already drew this line: rule `CLI-30` (ruling `NEED-147`, `ASK-24`) forbids
`src/domain/models.ts`, `src/cache/**`, `src/rendering/**`, `src/resolve.ts` from importing
anything MAX, "so the package is a move, not an untangling"
(`max-cli/docs/dev/ARCHITECTURE.md:48-53`). The plan is to **copy** those files, not move them —
max-cli stays untouched until the Telegram slice works (§6, Phase 4).

| max-cli file | In cli-messaging | Change needed |
|---|---|---|
| `src/domain/models.ts` | `domain/` | add provider, account, locator, identity, thread; drop `timeOfMessageId` (L1) |
| `src/cache/driver.ts`, `open.ts`, `drivers/*` | `store/driver` | none — the Node/Bun SQLite seam is exactly what a third runtime-agnostic user needs |
| `src/cache/schema.ts` | `store/schema` | **rewritten**, not copied (L2–L5). The FTS5-with-triggers pattern and the "ranges mean completeness" idea carry over |
| `src/cache/store.ts` | `store/` repositories | pattern carries (upsert with `coalesce`, membership deleted per chat only); SQL rewritten for composite keys |
| `src/rendering/messages.ts` | `render/` | none expected |
| `src/resolve.ts` | `resolve/` | none; `isId` already accepts `-100…` (`src/resolve.ts:5`). Add `@username` |
| `src/sends/guard.ts`, `journal.ts`, `permissions.ts`, `recipients.ts` | `guard/` | `cid?: number` → `sendId: string` (L7); drop the `Settings` import for a narrow options type; MAX-only `ChatAction` values become adapter-declared |
| `src/export.ts`, `src/deadline.ts`, `src/profile.ts`, `src/runs/run.ts`, `src/runs/recording.ts` | candidates | imports are cli-core only (read 2026-09-26); **to verify** in Phase 1 before moving |
| `src/commands/paging.ts`, `src/output.ts` | candidates | to verify |

### From max-cli — pattern only, code stays

| max-cli | Why the code does not move |
|---|---|
| `src/client.ts` (2655 lines) | the MAX adapter. Its **shape** (`account`, `chats`, `contacts`, `messages`, `live`) is the template for the adapter port |
| `src/server/` (`max serve`, warm connection over a local socket) | imports the MAX protocol (`src/server/server.ts:7-14`). The *pattern* — one process owns the connection, commands talk to it — is what Telegram's `watch` and background sync need |
| `src/mcp/` | imports `MaxClient`. Extracted in Phase 3 once `tg` has the same tools |
| `src/commands/*` | commands are extracted as shared builders in Phase 3, after both CLIs have them |
| `src/runs/events.ts` | imports the MAX frame type |
| `src/transcribe/` (voice → text) | generic in nature — Telegram voice notes are Ogg/Opus too. Later candidate |

## 2. Extraction map: where MAX leaked into "generic" code

Each of these is inside the `CLI-30` boundary and would break Telegram if copied as is.

| id | Leak | Where | Fix in cli-messaging |
|---|---|---|---|
| L1 | "a message id holds its send time (`id >> 16`)" — a MAX property | `src/domain/models.ts:267`, duplicated at `src/client.ts:2401` | stays in the MAX adapter |
| L2 | `messages_by_id` finds a message by id "without knowing which chat" | `src/cache/schema.ts:97` | ids are unique only per chat (Telegram channels) or per account (Telegram private chats); every key is composite |
| L3 | `sync_marker` — one row, MAX's login delta | `src/cache/schema.ts:73-76` | `sync_state (account, key, value)` — per account, per provider |
| L4 | the store is one file per profile, in the **cache** dir | `src/cache/index.ts:30` | one store per user, in the data dir, holding every account and provider |
| L5 | `migrate` drops and rebuilds everything but `messages` and `ranges` | `src/cache/schema.ts:234` | forward-only additive migrations — a rebuild would erase identity links and notes |
| L6 | `PersonSource` = `login \| info \| participant \| sync` | `src/cache/store.ts:6` | free text, declared by the adapter |
| L7 | `cid?: number` in the guard | `src/sends/guard.ts:26` | `sendId: string` — Telegram's `random_id` is 64-bit |
| L8 | `Attachment.fileId` / `videoId` | `src/domain/models.ts:39-40` | `providerRef` (opaque JSON) + common fields |
| L9 | `ChatKind` has no bot, forum, or saved-messages notion | `src/domain/models.ts:10` | add `saved` and `isBot`; forum = group with the `threads` capability |

**Not extracted now** (one implementation only): folders, group admin, inbox, scheduled messages,
account sessions, contact import. They stay in max-cli until Telegram needs them.

## 3. Package boundaries

```text
 tg (tg-cli)                       max (max-cli, later)            future: wa, signal…
 src/commands/  src/mcp/           src/commands/  src/mcp/
      │ domain types only               │
      ▼                                 ▼
 src/telegram/  ← only place that      src/client.ts …
 imports @mtcute/*  (lint rule)
      │ implements the port
      ▼
 ┌──────────────────── @leemour/cli-messaging ────────────────────┐
 │ domain   Chat · Message · Identity · Person · Locator ·        │
 │          Capabilities · the adapter port (interfaces only)     │
 │ store    SQLite seam (Node/Bun) · schema · migrations ·        │
 │          repositories · ingestion (upsert, tombstones, ranges) │
 │ search   SearchProvider interface · FTS5 implementation        │
 │ guard    read-only · allow-list · recipients · hourly limit ·  │
 │          send journal · send identity                          │
 │ render   message feed · resolve   name → chat, never a guess   │
 │ testing  fake adapter · in-memory store                        │
 └────────────────────────────────────────────────────────────────┘
      ▼
 @leemour/cli-core   output · errors · exit codes · keyring · config · paths · clocks
```

- **One npm package with subpath exports** (`/store`, `/search`, `/guard`, `/testing`), like
  cli-core. Not a workspace of five packages: nothing needs them versioned apart yet.
- **Nothing in cli-messaging imports a provider library.** No `@mtcute`, no `ws`.
- tg-cli is **one package, split by directory**, as max-cli is (`NEED-12`). Two lint rules, copied
  from max-cli's `biome.json`: `src/commands/` and `src/mcp/` never import `src/telegram/`
  internals or `@mtcute/*`; `@mtcute/*` is imported only under `src/telegram/`.
- During development tg-cli uses `"@leemour/cli-messaging": "link:../cli-messaging"`; publishing
  switches it to a version.

### The adapter port (sketch — the spike settles the details)

```ts
interface MessengerAdapter {
  readonly provider: Provider            // "telegram" | "max" | …
  readonly capabilities: Capabilities
  connect(): Promise<Account>            // also binds the profile to one account (max-cli MAX-12)
  close(): Promise<void>
  chats: { list(page: PageRequest): Promise<Page<Chat>>; show(ref: string): Promise<ChatCard> }
  messages: {
    history(chat: Id, window: HistoryWindow): Promise<Message[]>
    get(chat: Id, ids: Id[]): Promise<Message[]>
    send(chat: Id, draft: Draft, identity: SendIdentity): Promise<Message>
  }
  identities: { get(ids: Id[]): Promise<Identity[]> }
  updates?: { subscribe(onEvent: (event: MessageEvent) => void): Unsubscribe } // canRealtime
}
```

Optional operations are optional members, and `capabilities` says so up front — a command checks
the capability and exits with a typed error; it never calls and catches.

## 4. The store: a system of record, ready for a CRM

### Where it lives

`<data dir of "cli-messaging">/messages.db`, mode 0600 — for example
`~/.local/share/cli-messaging/messages.db`. One file for every provider and every account, because
"everything I discussed with Ivan, in Telegram and in MAX" must be one query, and FTS5, foreign keys
and joins do not cross `ATTACH`ed files cleanly. This is decision **NEED-A** (§9).

The mtcute session database is **not** in this file: it is a credential (§5).

### Keys

- **Internal integer keys** (`pk`) for joins and for FTS5's `rowid`. They never leave the database.
- **Natural keys are always composite**: a chat is `(account, native_id)`, a message is
  `(chat, native_id)`, an identity is `(provider, native_id)`.
- **The external id is the locator**: `{ provider, account, chat, message }`, all strings, printed as
  `msg:telegram/<account>/<chat>/<message>`. Every search hit, every future AI answer cites
  locators; `tg messages show <locator>` opens one. A provider deep link (`https://t.me/c/…`) is
  derived from it when one exists — **inferred** that private chats and basic groups have none, to
  verify in Phase 1.

### Identity and person — the CRM foundation

```text
 account ──< chat ──< message >── sender identity >── person
                                     (provider,        (the human;
                                      native_id)        ours, ULID)
```

- **An identity is a person as one provider sees them** — a Telegram user id, a MAX contact id.
  Identities are per provider, not per account: the same Telegram user seen from two of my accounts
  is one identity. What each account knows about them (the name I saved them under, whether they
  are in my contacts) goes in `account_identities`.
- **A person is ours.** Every new identity gets its own person, 1:1, at ingestion. Linking two
  identities means pointing both at one person. Unlinking gives the identity a fresh person; notes
  stay with the person they were written on. **No provider data is ever changed by a link.**
- **Every link is recorded with how it was made**: `initial`, `manual`, `auto:phone`, `auto:self`;
  a confidence; when; by whom. Link changes are appended to `identity_link_events`, so an unlink
  loses nothing and a bad auto-link can be found and undone.
- **The owner's own identities link to one `self` person.** That makes "me" the same across
  messengers, and "messages I sent" one query.
- **A contact is a query, not a flag** — max-cli's `NEED-105`, carried over by name: someone is a
  contact of an account because a dialog with them exists (or the provider says so in
  `account_identities`), never because a column was set by hand.
- **Phone numbers are stored for matching only, as a keyed hash** (HMAC with a key kept in the
  keyring), never in plain text. That is enough for `auto:phone` linking across messengers and keeps
  max-cli's rule that a phone number never reaches a log, a fixture or a document. A CRM that must
  *show* numbers adds a plain column later, deliberately.

### Tables (sketch)

```sql
accounts            (pk, provider, native_id, name, created_at,           UNIQUE(provider, native_id))
identities          (pk, provider, native_id, username, name, is_bot, phone_hmac,
                     provider_metadata JSON, first_seen_at, updated_at,    UNIQUE(provider, native_id))
account_identities  (account_pk, identity_pk, saved_name, is_contact, updated_at)
persons             (pk, uid ULID UNIQUE, name, is_self, created_at, updated_at)
identity_links      (identity_pk PRIMARY KEY, person_pk, method, confidence, linked_at, linked_by)
identity_link_events(pk, identity_pk, from_person_pk, to_person_pk, method, at, by)

chats               (pk, account_pk, native_id, kind, title, username, parent_chat_pk,
                     unread_count, last_message_at, provider_metadata JSON, updated_at,
                     UNIQUE(account_pk, native_id))
chat_members        (chat_pk, identity_pk, role, updated_at, PRIMARY KEY(chat_pk, identity_pk))
threads             (pk, chat_pk, native_id, kind, title, UNIQUE(chat_pk, native_id))  -- forum topics

messages            (pk, chat_pk, account_pk, native_id, thread_pk, sender_identity_pk, sender_chat_pk,
                     sent_at, edited_at, deleted_at, text, entities JSON, reply_to_native_id,
                     forward JSON, grouped_id, outgoing, provider_metadata JSON,
                     ingested_at, ingested_via,                           UNIQUE(chat_pk, native_id))
message_revisions   (message_pk, text, entities JSON, edited_at, captured_at)
attachments         (pk, message_pk, position, kind, mime, name, size, width, height, duration,
                     provider_ref JSON, local_path)
reactions           (message_pk, reaction, count, mine, updated_at)

sync_ranges         (chat_pk, from_key, to_key)       -- windows held completely; absent inside = deleted
sync_state          (account_pk, key, value)          -- per-provider checkpoints
messages_fts, chats_fts, identities_fts               -- external-content FTS5, kept by triggers
schema_migrations   (version, min_compatible, applied_at)
```

Why each non-obvious piece is there:

- `account_pk` on `messages` — Telegram delete updates for private chats and basic groups carry
  message ids **without a chat** (the ids are unique per account there). An index on
  `(account_pk, native_id)` finds them. (**Inferred** from the MTProto schema; verify in Phase 2.)
- `sender_chat_pk` — a channel post, or a message sent "as the group", has a chat as its author.
- `reply_to_native_id` as text, not a foreign key — the replied-to message is often not stored yet.
  Reply chains are what research needs most; they are never dropped.
- `forward` keeps the original author, chat, date and, where possible, the original locator, so
  "original vs forwarded" is a search filter.
- `deleted_at` is a tombstone. Nothing is hard-deleted by sync.
- `message_revisions` gets a row only when an edit is seen. Cheap, and the only record of what a
  message said before it was changed.
- `sync_ranges` keys are the provider's ordering key — Telegram's message id (monotonic per chat),
  MAX's time. It generalises max-cli's `ranges` (`src/cache/schema.ts:104-109`).

**What is deliberately not created now:** notes, tags, interactions, commitments, follow-ups. They
all hang off `person_pk` or `message_pk`, both of which exist from day one. Creating them empty would
freeze a guessed shape; with additive migrations they cost one migration each when the first CRM
command is written.

### Migrations

- **Forward-only, additive, numbered.** Never drop, never rebuild. A new column is nullable or has a
  default. A test migrates every shipped version.
- **Compatibility is declared, not assumed.** `schema_migrations` carries `min_compatible`. An older
  `max` opens a newer file if its own version is at least `min_compatible` — additive changes keep
  old statements valid. Only a breaking change raises `min_compatible`, and that is a major version
  of cli-messaging. This is what lets `tg` and `max` share one file while installed at different
  versions.
- Concurrency: WAL + `busy_timeout`, as max-cli (`src/cache/driver.ts`). One background ingester
  per account at a time, enforced by a lease row (max-cli's `fetch_lease` pattern).

## 5. Telegram adapter design

### Transport

- **mtcute, pinned exactly at 0.32.x** (pre-1.0; `npm view` 2026-09-26: `@mtcute/node` 0.32.3).
- **The native dependency is a spike question.** `@mtcute/node` depends on `better-sqlite3`
  (`npm view`, 2026-09-26), a native module. pnpm 10+ does not run its install script unless allowed
  (the mtcute FAQ describes `onlyBuiltDependencies`), so a global `pnpm add -g` may install a `tg`
  without working SQLite. Two ways, chosen by measurement in the spike:
  - **A** `@mtcute/node` as is, if `npm i -g` and `pnpm add -g` into a clean prefix both work on
    Linux and macOS;
  - **B** `@mtcute/core` plus our own ~40-line storage driver over `node:sqlite` / `bun:sqlite`.
    The docs describe the interface (`ISqliteDatabase`: `exec`, `prepare`, `transaction`, `close`);
    `transaction` would be `BEGIN`/`COMMIT`. B also needs the network transport that `@mtcute/node`
    provides — **unknown** whether that is usable without `better-sqlite3`.
- The spike runs on **Node only**. Bun is measured after, not assumed.

### Auth and credentials

- `tg session start qr | phone` — max-cli's command names (`session start|end`), not `auth`. QR
  and phone + code + 2FA password; the docs describe both as `tg.start({ qrCodeHandler, password })`
  and `sendCode` / `signIn`. Prompts never echo; nothing goes on the command line.
- **The mtcute session database is a credential** — it holds the auth key. It lives in the state
  dir (`<state>/sessions/<profile>.db`), mode 0600, and is excluded from export, backup, the doctor
  report and any log. Moving only the auth key into the OS keyring is possible in principle (mtcute
  keeps auth keys in their own repository); not promised.
- **`api_id` / `api_hash`** are read from the keyring (service `tg-cli`), put there by a
  `bin/tg-credentials` script that prompts without echo. Never through chat, never on argv. Who owns
  the id at publication is **NEED-C**.
- **Profiles as in max-cli**: the first word (`tg work chats list`), bound to one Telegram user id on
  first login; a different account is refused (max-cli `MAX-12`).
- **Unlike max-cli, `tg` does not pretend to be an official client.** max-cli's "look like the
  official client" rule is a MAX constraint. Telegram expects a registered `api_id` and an honest
  device and app name.
- Multi-account: one profile = one account = one session file. The store holds all of them.

### Mapping

`src/telegram/map.ts` is the only file that knows mtcute's object shapes, as `src/domain/map.ts` is
in max-cli. Chat ids are mtcute's marked ids as strings (`-100…` for channels and supergroups);
every id leaves the adapter as a string. Kinds: user → `dialog` (+`isBot`), basic group and
supergroup → `group`, broadcast channel → `channel`, Saved Messages → `saved`; a forum is a group
with threads. Entities (links, mentions, formatting) are kept as JSON; the plain text is what is
indexed.

### Updates

mtcute keeps the update state (`pts`) in its session storage and catches up after a restart (the
docs describe `catchUp`). The adapter turns updates into `MessageEvent`s — new, edit, delete,
reaction — and the store ingests them. When catch-up gives up on a chat (a gap too long to replay),
the chat's `sync_ranges` are cut at that point, so "absent means deleted" is never claimed across a
gap. **Two processes must not both drive one session** (both would advance `pts`); one owns the
connection — the `max serve` pattern — and the others ask it, or run one-shot without updates.

### Sending

- **Every send has a send identity before it goes out** — a `random_id`, stored as a string in the
  send journal's `reserved` line before the request. A retry reuses it. After a timeout with no
  answer the result is `outcome_unknown` (exit 14) naming the id, and `tg messages send --send-id
  <id>` repeats it without risking a second message. This is max-cli's `cid` model
  (`max-cli/docs/dev/ARCHITECTURE.md` §6), generalised.
- **Unverified:** whether mtcute's high-level `sendText` accepts a `random_id`. If it does not, the
  adapter calls `messages.sendMessage` directly. **Unmeasured:** what Telegram answers to a repeated
  `random_id` (max-cli measured MAX's `cid` in Saved Messages across two connections; the spike does
  the same).
- **FloodWait is `rate_limited` (exit 8) with `retryAfterMs`.** Reads may sleep through a short wait
  (mtcute's flood waiter, threshold configured); a send never sleeps and never retries past it.
- The guard runs before every write, unchanged from max-cli: read-only profile, allow-list,
  recipients, hourly limit, journal without the text.

## 6. Search

- A `SearchProvider` interface in `cli-messaging/search`, not SQL in commands:
  `search(query, filters) → Page<Hit>`, where a hit is a locator, the message, the chat title, a
  snippet and a score. Filters: providers, accounts, chats, sender identity **or person**, date range,
  thread, has attachment, original vs forwarded, outgoing.
- First implementation: FTS5. **Which tokenizer is a measurement, not a decision.** max-cli chose
  `trigram` for substring matches on Cyrillic names (`src/cache/schema.ts:129-143`). On large groups
  trigram indexes are big, need three characters, and rank word queries weakly under BM25. Phase 2
  measures, on one real large group: `trigram` alone vs `trigram` for names + `unicode61
  remove_diacritics 2` for message text — index size, query time, and ranking on ~20 real queries.
- Later layers (vector retrieval, reranker, thread expansion, LLM synthesis) are further
  `SearchProvider`s or a composite over them. Not built now.
- Remote search (`messages.search` on Telegram) is a capability, `canSearchRemote`, later.

## 7. Capabilities

A `Capabilities` object in the domain from the first commit — cheap, and it stops commands assuming
every messenger can do everything: `edit`, `delete`, `react`, `schedule`, `forward`, `threads`,
`groups`, `readReceipts`, `searchRemote`, `realtime`, `history` (how far back), `maxTextLength`.
Filled by each adapter; printed by `tg commands --json` for agents. Only the fields a command
actually checks are added; the full list grows in Phase 4 when MAX fills it too.

## 8. Phases — small, independently shippable pull requests

**Phase 0 — spike (tg-cli, throwaway allowed).** Goal: prove the transport and measure the unknowns.

| PR | What |
|---|---|
| 0.1 | tg-cli scaffold: pnpm, TypeScript, Biome, Vitest, lefthook, cli-core; the two lint rules; `bin/tg-credentials` |
| 0.2 | `tg session start qr\|phone`, `tg chats list`, `tg messages list <chat>`, `tg messages send me <text>` — domain types copied locally, no store |
| 0.3 | spike report in `tg-cli/docs/plans/`: every measurement in §9's criteria, and the A/B transport choice |

**Phase 1 — foundation.** cli-messaging comes into being here, seeded by what the spike used.

| PR | What |
|---|---|
| 1.1 | cli-messaging scaffold + domain, render, resolve, SQLite seam (copies from max-cli, leaks L1, L8, L9 fixed) |
| 1.2 | cli-messaging guard + journal, generalised (L7) |
| 1.3 | cli-messaging store v1: §4 schema, migrations with `min_compatible`, repositories, FTS; identities get a 1:1 person |
| 1.4 | tg-cli on cli-messaging: the adapter behind the port; `account show`, `chats list\|show`, `messages list\|show\|context` |
| 1.5 | `messages send\|reply` through the guard, with the send identity and `outcome_unknown` |
| 1.6 | `doctor`, `commands`, `--json`/`--jsonl`, typed errors — and a test that stdout carries one JSON value |
| 1.7 | `tg watch` in the foreground, `--jsonl` |

**Phase 2 — local archive and search.** The business milestone: connect Telegram, index a few
large groups, search the whole history locally.

| PR | What |
|---|---|
| 2.1 | ingestion: every read writes to the store; `--offline` answers from it |
| 2.2 | `tg backfill <chat>` — resumable via `sync_ranges`, throttled, FloodWait-aware |
| 2.3 | `tg serve` — one process owns the connection, ingests updates (new, edit, delete, reaction) |
| 2.4 | tokenizer measurement (§6), then `tg messages search` on the `SearchProvider` |
| 2.5 | `tg sync status`, `tg export` |

**Phase 3 — agent-safe runtime.** Skill, MCP (a second front end over the same operations, as in
max-cli §17), capability discovery. MCP tools and command builders that are now alike in `tg` and
`max` move to cli-messaging.

**Phase 4 — the platform.** max-cli moves onto cli-messaging (under max-cli's own rules: worktree,
`🚧` claim on its backlog, a plan in its `docs_ai/`); its existing history is imported into the
shared store; the capability model is filled by both; `auto:self` and `auto:phone` identity links
are switched on. First cross-messenger read: `msg person show <name>`.

**Not in any phase here:** CRM commands, notes, embeddings, AI summarisation, polls, stickers,
stories, calls, admin features, a UI. If it does not help *read → sync → search → context → safe
action*, it waits.

## 9. The spike: definition and success criteria

Run against the owner's real account, sending only to Saved Messages.

1. `tg session start qr` and `tg session start phone` (with 2FA) both succeed; a second command
   needs no prompt.
2. `tg chats list --json` and `tg messages list <chat> --json`: stdout is one JSON value, stderr is
   empty, every id is a string.
3. `tg messages send me "…"` sends once. The same `random_id` sent again — including from a second
   connection — produces **one** message, or the spike records exactly what Telegram does instead.
4. Every command exits within a second of printing (no open socket or timer keeps the process).
5. `@mtcute/*` is imported only under `src/telegram/`; a deliberate violation turns `pnpm lint` red.
6. The session file is mode 0600 and appears in no output, log or error.
7. `npm i -g` and `pnpm add -g` of a packed `tg` into a clean prefix both give a working `tg` — or
   the report says which fails, and transport B is tried.
8. The report counts lines: reused from cli-core, copied from max-cli, new.

## 10. Risks

| id | Risk | Mitigation |
|---|---|---|
| R1 | `better-sqlite3` native build fails on global install | spike criterion 7; transport B |
| R2 | mtcute is pre-1.0; the API moves | exact pin; all of it behind `src/telegram/` |
| R3 | two processes drive one session and corrupt update state | one owner process (`tg serve`); others one-shot without updates |
| R4 | FloodWait while backfilling large groups | throttle, resumable ranges, typed `rate_limited`, never retry sends |
| R5 | account limits for unofficial clients (spam, shared `api_id`) | registered `api_id` (NEED-C), guard limits, no bulk send features |
| R6 | update gaps silently lose deletes and edits | cut `sync_ranges` at a gap; `sync status` shows it |
| R7 | two CLIs, one store, different schema versions | additive migrations + `min_compatible` (§4) |
| R8 | trigram index size and ranking on large groups | Phase 2 measurement before committing (§6) |
| R9 | Telegram message ids unique per account in private chats | `account_pk` on messages; composite keys everywhere (L2) |
| R10 | the session database leaks through backup/export/doctor | excluded by path, and a test for each |

## 11. Decisions that need the owner

- **NEED-A — one store for all messengers, or one file per CLI?** Recommended: one file in
  `~/.local/share/cli-messaging/`, with `min_compatible`. Per-CLI files make every cross-messenger
  query an `ATTACH` with no foreign keys.
- **NEED-B — keep max-cli untouched until Phase 4?** Recommended: yes. max-cli has several agents,
  a security batch and a pre-release in flight; its own ruling (`NEED-147`) already says the package
  is extracted when the second messenger starts, which is this.
- **NEED-C — whose `api_id` does a published `tg` use?** Recommended: for the spike, the owner's own
  from my.telegram.org; at publication, one registered for the app, overridable per user.
