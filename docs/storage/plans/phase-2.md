# Phase 2 — search by words: BM25, typo correction, a query language

Plan, 2026-09-30. **Approved by the owner 2026-10-01. Items 1–5 are built (the migration, filling and upkeep, the store's search steps, the query parser, typo correction), and item 6 without context and name resolution, which come with item 7; the rest is not.** Questions of §9 answered
2026-10-01: 1–3 A, 4 B. It follows [`../decisions.md`](../decisions.md):
SQLite FTS5 (NEED-374 A); every word first, any word when nothing is found, BM25 ranks, trigram typo
correction over the vocabulary (NEED-375 A); the substring index stays as the last fallback (NEED-379 A);
a typed query language and completeness per chat (NEED-400 A). Requirements §3, §6–§11, §22–§23, §26,
§30 "Phase 2" are the brief.

Evidence labels, as in the rest of this folder: **verified** has a `path:line` at `8af0f3b` or a command
that was run; **measured** is a run of the benchmark corpus, with its numbers; **docs say** names the
source; **inferred** is reasoning. The measurement scripts of §2 ran in a scratch directory and are not
in the repository; item 8 moves what the acceptance needs into `bench/search/`.

## 1. Goal

At the end of phase 2, `tg messages search` and `max bot messages search` (and the MCP tool
`messages_search`):

- find messages by **words of the normalized text**, ranked by **BM25**, every word required first;
- **correct a word the store does not know** to the nearest known ones (edit distance ≤ 2) and say so;
- fall back to **any word**, then to the **substring index**, only when the step before found nothing;
- take **operators** in the query — `from:` `chat:` `after:` `before:` `has:`, `"phrase"`, `-word`, `OR`;
- say **how complete the archive is** for each chat the answer comes from;
- show **surrounding messages** in the pretty output;
- skip chats marked **not searchable**;
- answer at 1M messages within the numbers of §6.

max-cli's personal `max messages search` reads max's own profile cache until the fold-in (plan
[phase 1 §8](phase-1.md#8-max-clis-cache-later)); it gets this search then, not in phase 2.

No schema change forces an upgrade: `min_compatible` stays 6 (§7).

**In phase 2 too: one search over several accounts and both messengers** (requirements §7, `--source`;
**NEED-456 B**, owner 2026-10-01) — S13.

## 2. Current state

**Search is substring search, newest first.** `find` (`src/store/store.ts:411`) matches
`m.pk IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)` (`:434`) over the raw `text`,
orders by `sent_at DESC` (`:478-484`), no score. `messages_fts` is FTS5 `trigram` over `text`
(`src/store/migrations.ts:259`, version 5). `wordsOf` (`:1002`) keeps words of three letters or more,
all required. Its first doc comment (`:998-1000`) is stale; lane A's slice 6 removes it. **verified**

**Callers** — every one the plan changes, **verified** by grep at `8af0f3b` (cli-messaging),
`be9641c` (tg-cli), `122376a` (max-cli):

| Caller | What it calls |
|---|---|
| `messages search` (`src/cli/messenger/messages-command.ts:95`) | `services.messages.search` |
| MCP `messages_search` (`src/mcp/tools/messages.ts:85`) | the same service |
| `services.messages.search` (`src/services/messages.ts:136`) | `store.find({ text | pattern, account, chatId, limit })` |
| max-cli `bot messages search` (`src/commands/bot-people.ts:207`) | `store.find({ text, senders, … })` |
| max-cli `between`, `bot-people.ts:128`, `:230` | `store.find({ senders, together, perChat })` — no text; untouched |
| `MessageStore.search` (`store.ts:172`, `:859`) | no caller outside tests |

tg-cli mounts the shared `messagesCommand` (tg-cli `src/program.ts:47`) and has no search of its own.

**What phase 1 left ready.** `normalized_text` and `normalizer_version` on every message written by a
version-6 build; rows older than that are filled by `backfillNormalized`
(`src/store/sqlite/backfill.ts`) on open when there are at most 5,000 (`store.ts:225`), otherwise by
`store migrate`. A deleted message has `text = ''` and `normalized_text = NULL`. `chats.message_count`
is kept by triggers (`drizzle/20260930003740_version-6-message-count/migration.sql`);
`chats.is_searchable` exists (`src/store/sqlite/schema.ts:98`) and nothing reads it. **verified**

**Completeness today.** `sync_ranges` holds stretches of a chat fetched without gaps, keyed by the
messenger's message id, and only `store fetch` writes them (`src/services/archive.ts:129`). Whether a
fetch reached the chat's first message is returned (`:148`) and not stored. `store check` therefore
compares times instead — the chat's newest message by the chat list against the newest held
(`src/cli/messenger/store-maintenance-command.ts:117-119`, `:206`). **verified**

**Measured for this plan**, 2026-09-30, Node 24.x / SQLite 3.53.3 and Bun 1.3 / SQLite 3.53.0, on the
benchmark corpus (`bench/search/gen.ts 1000000 42`: 1M messages, a 500k chat, a 1,996-message chat, a
3,808-message sender):

1. **A partly filled external-content FTS5 index breaks.** When the word index is created over existing
   rows and filled later, an edit, a tombstone or the normalization backfill of a row not yet filled
   sends a `'delete'` for a row the index never had. `integrity-check` then fails with «database disk
   image is malformed», under Node and Bun. The same steps on `content='', contentless_delete=1` pass,
   and so does filling in batches with `INSERT OR REPLACE` over rows a trigger already indexed.
2. **The fill**: 1M rows in batches of 20,000 took 14.4 s, a batch p50 248 ms, max 408 ms; `optimize`
   1.5 s.
3. **Queries, p95 ms** (20 word pairs each; "join" is `CROSS JOIN messages` then the filter; "token" is
   a `scope` column in the index holding `c<chat>` and `s<sender>`):

   | query | filter | join | token |
   |---|---|---|---|
   | every word, rare | all · big chat · small chat · sender | 2.0 · 1.7 · 0.9 · 1.1 | — · **61.8** · 0.3 · 1.1 |
   | every word, common | all · big chat · small chat · sender | 40 · 34 · 24 · 21 | — · 43 · **7.0** · **5.4** |
   | every word as a beginning, common | same | 34 · 32 · 22 · 22 | — · 38 · 8.6 · 9.2 |
   | any word, rare | same | 68 · 101 · 28 · 30 | — · 75 · **1.1** · **1.3** |
   | any word, common | same | **191** · **146** · 108 · 109 | — · 146 · **4.9** · **6.0** |

   Any word across all chats, ranked inside FTS5 (`ORDER BY rank LIMIT 20` before the join): rare 26,
   common **118**.
4. **The vocabulary through `fts5vocab`** works over the contentless index: 528,053 terms at 1M, one
   term looked up in 0.01–2.1 ms, every term listed in 348 ms. A word whose only message is deleted
   leaves `fts5vocab` at once (checked on a small table, Node and Bun).
5. **The cost on writes.** 200,000 inserts in transactions of 200 rows: no index 4.7 µs a row, today's
   trigram index 77.6 µs, trigram plus the word index 110.4 µs. So the word index adds about 33 µs a
   message; on the store's 7,614 rows/s at 1M (lane A's baseline) that is roughly 6,100 rows/s
   (inferred), 3 ms more for a page of 100 messages.

So: word beginnings cost about what whole words cost; a scope token turns small-scope "any word" from
~100 ms into ~5 ms and makes a big chat worse; "any word" across a big scope stays 118–146 ms; writing
gets about a fifth slower.

**Every runtime in use has what S1 needs.** `contentless_delete` needs SQLite 3.43 (docs say). All
three packages require Node ≥ 22; node:sqlite in Node 22.5.0 is SQLite 3.46.0, in 22.13.0 3.47.2
(verified, `npx node@22.5.0`); Bun 1.3 on Linux is 3.53.0. **Correction 2026-10-01:** Bun on macOS uses the
system's `libsqlite3.dylib` (docs say, Bun `nodejs-compat.mdx`): 3.43.2 on macOS 14 and 15, 3.51.0 on
macOS 26, and the S1 table, `fts5vocab`, delete by rowid and `integrity-check` work on all three
(measured, GitHub runners, run 36853255969). macOS 13 and older cannot be run there; their SQLite is
probably below 3.43 (inferred), and under Bun the version-12 migration would fail on them.

**The store rewrites a message's sender and normalized text on every re-save.** The update sets each
field to `coalesce(new, old)` (`src/store/sqlite/messages.ts:57-64`, at `cbd7ce7`), `senderIdentityPk`
and `normalizedText` among them (`:89`). So a sender unknown at first is filled in later, and the
normalized text is written again even when it did not change. **verified**

## 3. Decisions made here

**S1 · The word index is contentless, with delete support.**

```sql
CREATE VIRTUAL TABLE message_words USING fts5(
  normalized_text, scope,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2', prefix = '3');
```

Why: it survives being filled after the triggers exist (§2, measurement 1), which a large file needs
(S3); it carries the `scope` column without a new column on `messages`; bm25 and `fts5vocab` work on it
(measured). Its price: no `highlight()`/`snippet()` — search shows text from `messages`, as it does
today. Triggers, hand-written in a `--custom` migration:

- after insert on `messages`: insert `(pk, normalized_text, scope)`;
- after update of `normalized_text`, `sender_identity_pk` or `chat_pk` (edit, tombstone, backfill,
  un-tombstone, a sender learned later), **only when one of them really changed**
  (`WHEN old.x IS NOT new.x OR …`): delete by rowid, insert. Without that guard every re-save of a
  message — each fetch of a page already held — rewrites its index entry;
- after delete: delete by rowid.

`scope` is `'c' || chat_pk` and, when there is one, `' s' || sender_identity_pk` — store keys, never
provider ids. A deleted message has no normalized text and contributes nothing.

**S2 · The substring index stays as it is.** `messages_fts` (trigram over `text`) keeps its triggers and
its role as the last step (NEED-379 A), and it answers searches while the word index is not ready (S3).

**S3 · A large file gets its word index in batches, after the migration.** The migration creates the
index, the triggers and a state row. On a file with at most `BACKFILL_ON_OPEN` messages it also fills
the index in the same transaction. Otherwise it records a watermark — the highest `pk` at the time — and
the index is filled up to it in batches of `pk`, one `BEGIN IMMEDIATE` each, `INSERT OR REPLACE`, like
`backfillNormalized`. Batches of 5,000 rows (about 60 ms, inferred from measurement 2) keep other
processes' wait far under the 5 s `busy_timeout`. Rows written after the migration are indexed by the
triggers. Who runs the batches (**NEED-453 A**, owner 2026-10-01): `store migrate` always, and `messages
search` too, up to ~200 ms per call — **both fills in that slice**: the normalization backfill first,
then the word index. Otherwise a max user with more than 5,000 messages waiting for normalization never
reaches "ready", since only `store migrate` normalizes them and max has none.

**The word index is ready** when the fill reached the watermark and no live message waits for its
normalized text. **Until then, search answers exactly as today** — substring, newest first — and says
on stderr what is missing and which command finishes it. One rule covers both a half-filled index and
rows still waiting for normalization, so no row is lost in between.

**S4 · The order a search runs in.** Each step runs only when every step before it found nothing,
except step 2, which tops step 1 up:

1. **Every word, as typed**, BM25.
2. **Every word as a word beginning** (`квартир*`), when step 1 returned fewer than the limit; new hits
   are added after step 1's. Words under three letters stay whole (`tv`).
3. **Typo correction**: each word the vocabulary does not know is replaced by its nearest known words,
   then steps 1–2 run again. A word counts as known when it is a whole term **or the beginning of one**
   (a range lookup on `fts5vocab`, `LIMIT 1`): otherwise `квартир valenca` would correct `квартир` to
   `квартира` and lose `квартиру`.
4. **Any word** instead of every word, as beginnings, with the corrections.
5. **Substring** over the raw text, every piece of three letters or more required.

Every hit says which step found it (`match`: `words`, `beginnings`, `corrected`, `anyWord`,
`substring`), and the answer lists the corrections (`valenca → valencia`). Why two word steps rather than
beginnings alone: `tie*` finds «tiempo»; the owner's example `tie` should find the message with the word
TIE first. Measured cost of step 2 over step 1: at most a few ms (§2 table).

**S5 · Operators and the fallback steps.**

| In the query | Steps 1–2 | 3 correction | 4 any word | 5 substring |
|---|---|---|---|---|
| plain word | required | corrected if unknown | relaxed to any | three letters or more, required |
| `"a phrase"` | a phrase of whole words | never | stays required | the phrase as one substring |
| `-word` | excluded | never | stays excluded | excluded |
| `a OR b` | as written | words inside are corrected | step skipped: the user chose | as written |
| filters | in the database at every step | | | |

A query of only filters (`from:alice after:2026-01-01`) is not a text search: it lists the matching
messages newest first, the way `find` with `senders` does today.

**S6 · How a filter reaches the index — by the size of the scope.**

- **Account** (every service query has one) and `after:`/`before:`: always in the join. Within one
  account, when the account holds every message of the file, the join adds nothing.
- **`chat:`**: a scope token when `chats.message_count` is under a threshold, the join above it. The
  threshold is set by item 8 between the measured 2k (token wins) and 500k (join wins); it is a constant
  in code.
- **`from:`**: the same rule; the size comes from
  `SELECT count(*) FROM (SELECT 1 FROM messages WHERE sender_identity_pk = ? LIMIT <threshold + 1>)`,
  bounded by the threshold.
- **No chat or sender filter**: the ranked limit runs inside FTS5 first (`ORDER BY rank LIMIT k`), then
  the join drops rows of other accounts; `k` is five times the limit, and when fewer than the limit
  survive, the full join runs. Why: 191 → 118 ms for common "any word" (measured).
- The query joins with `CROSS JOIN` so the index is searched first; a test asserts the plan with
  `EXPLAIN QUERY PLAN` (phase 1 §6).

What stays slow, honestly: **"any word" over a big scope** — a 500k chat, or all chats — at 118–146 ms
p95 for common words. It is reached only after every word, beginnings and correction found nothing.

**S7 · The vocabulary is derived, and fts5vocab is the truth.**

- `search_terms(term PRIMARY KEY, length)` and `search_term_trigrams(trigram, length, term)`, both
  `WITHOUT ROWID` — the prototype's `vocab` and `vocab_tri` (`bench/search/sqlite.ts:96-111`).
  **Correction 2026-10-01:** Drizzle cannot declare `WITHOUT ROWID` (verified, drizzle-orm 1.0.0-rc.4),
  so both are in the `--custom` SQL of version 12, not in `schema.ts`; only `search_index_state` is.
- The vocabulary of the index is `message_words_vocab`, an `fts5vocab` of type `col` (version 12). Every
  read of it filters `col = 'normalized_text'`, and every word query names that column: the `scope`
  tokens (`c12`, `s45`) are terms of the same index.
- Whether a word is known, and in how many messages, is asked of `fts5vocab` over `message_words`
  (0.01–2 ms). A candidate from the trigram table is used only when `fts5vocab` still has it — so a
  word from a deleted message never comes back as a correction.
- Built by the same batches as S3, from `fts5vocab`. Refreshed from new messages: the state row records
  the highest `pk` seen; a search tokenizes up to 20,000 newer messages' normalized text in JavaScript
  and adds their words, and `store migrate` does the rest. A word the refresh has not reached is still
  found by steps 1–2; only its typo is not corrected yet.
- **Correction 2026-10-01:** a correction is at least three letters long (`SHORTEST_CORRECTION`): two-letter
  words are nearly all filler, and without it `len` becomes `en` and never reaches the substring step.
- Numbers-only words have no trigrams (as the prototype). Edit distance: ≤ 1 up to four letters, ≤ 2
  above; the nearest distance wins, then the most frequent; at most five per word (`common.ts`
  `maxEdits`, `pick`). The code moves from `bench/search/common.ts` into `src/search/`.

**S8 · Ranking.** BM25 decides (requirements §9). Equal scores go newest first. No recency boost beyond
that tie-break in phase 2. `--newest` sorts the same matches newest first instead — today's order, for
whoever wants "the latest message that says X". Requirements §9 asks for a `SearchRanker` interface; the
ranking is one function in `src/search/` until a second ranker exists.

**S9 · Chats marked not searchable** (`is_searchable = 0`) are left out of every step, unless the query
names the chat (`chat:` or `--chat`): then it is searched, with a note. Nothing sets the flag yet; the
command that does is not part of phase 2.

**S10 · Completeness per chat** — three facts per chat the answer draws from (**NEED-455 A**, owner
2026-10-01):

- **up to date**: the newest message held against the chat's newest by the chat list (as `store check`);
- **gaps**: more than one stretch in `sync_ranges`;
- **reaches the start**: a `sync_state` entry `history_start:<chat>` that `store fetch` writes when it
  reaches the chat's first message — no migration.

A chat nobody fetched says `unknown`, not `complete`. JSON gets one entry per chat of the page; pretty
output gets one stderr line for the chats that are not complete.

**S11 · Commands.** `messages search` keeps its name and gains `--newest`, `--context <n>` (default 2 in
pretty output, 0 otherwise) and the operators; `--chat` stays and means `chat:`; both given and
different is an error. `--regex` stays as it is, without operators. Requirements §23's
`search status|rebuild` maps onto the `store` group (**NEED-454 A**, owner 2026-10-01): `store info` shows the index state
(filled to, ready, vocabulary refreshed to, `last_indexed_at`), `store check` runs FTS5
`integrity-check` on `message_words` too, `store reindex` rebuilds it.

**S12 · The store interface.** No FTS5 type crosses it. New methods, one step each, so a Postgres
backend can implement them: `matchWords(query, scope, { every | any, beginnings, limit })`,
`knownTerms(terms)`, `termCandidates(term, lengths)`, `matchSubstring(query, scope, limit)`,
`searchIndexState()`, `fillSearchIndex({ batches })`. The chain of S4 lives in a service
(`src/search/`), not in the store. `find` keeps its meaning — substring for `text`, plus `pattern` and
`senders` — until max-cli's bot search moves over (item 9); then `text` leaves `find`.
`MessageStore.search` (no callers) is removed. The `scope` of every step takes a list of accounts (S13).

**S13 · Across accounts and messengers** (NEED-456 B).

- **The default stays the account the command runs as** — the same answer as today for anyone who does
  not ask for more.
- `in:telegram`, `in:max` — every account of that messenger held in `messages.db`; `in:all` — every
  account of every messenger. `--source <messenger|all>` means the same (requirements §7); both given
  and different is an error.
- It is a read of rows already in the shared file: nothing connects to the other messenger, and nothing
  is sent or marked read.
- In the database it is `account_pk IN (…)` in the join; S6 is unchanged.
- `from:` and `chat:` resolve inside the chosen accounts; a name matching people or chats in two of them
  fails with the candidates and their messenger, as an ambiguous name does today.
- Each hit already carries its `locator` — messenger, account, chat, message (`store.ts`
  `formatLocator`), so the JSON needs no new field. Pretty output names the messenger before the chat
  title when the answer spans more than one account, and says which CLI opens the chat (`max …`,
  `tg …`). Whether the other CLI takes a locator as its chat argument is checked in item 6 (inferred,
  not verified).
- The MCP tool gets an optional `source` input with the same values.

## 4. The query language

```text
query    := part*
part     := filter | "-"? atom | "OR"
atom     := word | '"' words '"'
filter   := ("from" | "chat" | "after" | "before" | "has" | "in") ":" value
value    := word | '"' words '"'
```

| Operator | Means | Maps to |
|---|---|---|
| `from:alice` | a sender, by name or @username, through the name index `contacts search` uses | `sender_identity_pk`; S6 |
| `from:me` | what this account sent | `outgoing = 1` |
| `chat:"Valencia Expats"` | a chat, resolved as `--chat` is | `chat_pk`; S6 |
| `after:2026-01-01`, `before:…` | a day, local time; `after:7d` counts back from now | `sent_at`, in the join |
| `has:photo` (`video`, `voice`, `audio`, `file`, `sticker`, …) | an attachment of that kind | `EXISTS` in `attachments.kind` |
| `has:attachment` | any attachment | `EXISTS` in `attachments` |
| `has:link` | a link in the text | substring `://` in `messages_fts` |
| `in:telegram`, `in:max`, `in:all` | other accounts and messengers held in the file (S13) | `account_pk IN (…)` |
| `"a phrase"` | these words, in order | an FTS5 phrase |
| `-word` | not this word | FTS5 `NOT` |
| `a OR b` | either | FTS5 `OR`; binds tighter than the implied AND |

- Only these six names are operators. `https://…` or `12:30` is text.
- A value naming nobody fails before anything is searched: «from:alise — no one by that name; did you
  mean alice?» — the name indexes already answer that.
- `has:` with a kind the store never saw lists the kinds it has.
- A query of only negations is refused: «say what to find, not only what to leave out».
- `-` and `OR` in machine mode are the same as in the pretty mode; the MCP tool takes the same string.

## 5. Work items

Built **after lane A's slice 6** (reads and `find` on Drizzle, released): items 1 and 3 change the module
lane A lands for reads and search. One PR each, based on `main`.

1. **The migration** — first, `select sqlite_version()` under Bun on macOS; below 3.43 it is a question
   for the owner before anything else. Then the next free number, taken in
   [`../../plans/2026-09-29-parity-lanes.md`](../../plans/2026-09-29-parity-lanes.md) first. `message_words`
   and its triggers (S1), `search_terms`, `search_term_trigrams` (S7), `search_index_state(name, watermark,
   filled_through, terms_through, normalizer_version, built_at)`. Drizzle schema for the plain tables; a
   `--custom` SQL file for FTS5 and triggers. Filled in the migration when small (S3). `minCompatible` 6.
   None of phase 3's names (`message_links`, `conversations`, `conversation_messages`,
   `conversation_state`) is used.
2. **Filling and upkeep** — `fillSearchIndex` in batches (S3), then the vocabulary (S7); run by
   `store migrate`; `store info`, `store check`, `store reindex` (S11, NEED-454); the per-search slice if
   NEED-453 is A.
3. **The store's search steps** (S12): `matchWords` with the S6 rule, `knownTerms`, `termCandidates`,
   `matchSubstring`, the `is_searchable` rule (S9). `EXPLAIN QUERY PLAN` tests.
4. **The query parser** — `src/search/query.ts`, a pure function from the string to a tree, with the
   errors of §4.
5. **Typo correction** — `src/search/correct.ts`: edit distance and the choice from `bench/search/common.ts`,
   the vocabulary refresh (S7).
6. **The search service** — the chain of S4, ranking (S8), completeness (S10, NEED-455) including the
   `history_start` entry written by `store fetch`, context through `around`.
7. **`messages search` and MCP `messages_search`** — options and output of S11, help text, the MCP
   description, `docs/`. Release after it; tg-cli gets it with its bump.
8. **The benchmark through the store** — `bench/search/` runs the S4 chain through `openStore` at 100k and
   1M; the generator gains near-look-alike words (`valence` next to `valencia`) so correction precision
   means something; sets the S6 threshold with chats of 10k, 50k and 100k. Numbers in the PR and in
   `bench/search/results.md`.
9. **Across accounts and messengers** (S13) — `in:`, `--source`, the MCP `source` input, resolution and
   pretty output over several accounts; a test with a Telegram and a MAX account in one file. May ride
   with items 6–7 if small.
10. **max-cli's bot search** — `bot messages search` calls the service instead of `find({ text })`; then
   `text` leaves `find` (S12). A max-cli PR plus a cli-messaging one.

## 6. Test plan

- **Partial fill** (item 1): an index filled up to half, then an edit, a tombstone, an un-tombstone, a
  delete and a backfill of rows on both sides of the fill — `integrity-check` passes, and every live
  message is found once the fill completes.
- **Triggers**: every write path of the store keeps `message_words` in step; a deleted message is not
  found by any step; a sender learned on a later save is found by `from:` through the token; re-saving a
  message unchanged does not touch the index.
- **Installed builds**: a version-11 build writes into a file of the new version; its rows are found by
  words. The phase 1 "No rebuild" test covers the migration.
- **Readiness**: with the index half filled, or a message waiting for normalization, search answers by
  substring and says why on stderr.
- **The chain**: each step reached exactly when the one before found nothing; `match` and `corrections`
  in the JSON; the owner's scenarios in [`../search-indexes.md`](../search-indexes.md#scenarios--measured)
  as a table test (`tie` finds message 4 before 6; `len` only by substring; `tv` by words).
- **Parser**: every row of §4, every error message, `https://` and `12:30` as text.
- **Filters**: token and join give the same rows; `EXPLAIN QUERY PLAN` shows no scan of `message_words`
  per message row.
- **Not searchable**: left out of all chats, searched when named.
- **Completeness**: up to date, gaps, reaches the start, unknown.
- **Across accounts** (S13): without `in:` only the current account's rows; `in:all` finds a word in
  both a Telegram and a MAX account of one file; an ambiguous `from:` across them fails with both.
- **Machine mode**: stdout is one JSON value (or JSONL); notes on stderr only.

**Acceptance**, p95 through the store, Node 24, 1M benchmark corpus (item 8):

| Query | Target | Measured without the store (§2) |
|---|---|---|
| every word, any filter | ≤ 45 ms | 1–40 |
| every word + beginnings (steps 1–2 together) | ≤ 60 ms | inferred from the rows above |
| any word, small chat or one sender | ≤ 15 ms | 1.1–6 (token) |
| any word, all chats | ≤ 130 ms | 118 |
| any word, a 500k chat | ≤ 160 ms | 146 |
| the whole chain when every word finds nothing, all chats | ≤ 200 ms | inferred |
| typo correction alone | ≤ 20 ms | 15 at 1M (prototype, `results.md`) |
| filling 1M | ≤ 20 s total, no batch over 500 ms | 14.4 s, 408 ms at 20k per batch |
| storing messages (`bench/search/store.ts`, 1M) | ≥ 6,000 rows/s | ~6,100, inferred from §2 measurement 5 |

Fuzzy: 100% recall on the four typos of the benchmark (as measured); precision reported with the
look-alike words item 8 adds, no gate until the owner sets one. A Drizzle-and-async overhead of under
1 ms per query, as lane A's acceptance.

## 7. Existing `messages.db` files

- The new version is **additive**: a virtual table, triggers, three plain tables. `min_compatible` stays
  6, so every build since version 6 keeps opening the file and its writes are indexed by the triggers.
  No forced upgrade, no coordinated release.
- A file at or under `BACKFILL_ON_OPEN` messages is indexed during the migration. A larger one keeps
  answering by substring until S3's fill completes.
- Dropping `message_words` and the three tables loses no message (requirements §29.2, §29.5);
  `store reindex` rebuilds them.
- `NORMALIZER_VERSION` going up later means rows re-normalized and re-indexed by the same batches; the
  state row keeps the version the index was built with.

## 8. What phase 2 must not block

- **Phase 3** ([`phase-3.md`](phase-3.md), approved): its four tables keep their names; conversation
  context in search results is phase 3's, on top of this service.
- **Phases 4–5**: search by meaning ranks chunks, not messages; hybrid ranking can merge with S8's list
  later. Nothing here assumes one ranker.
- **The fold-in of max's cache** gives `max messages search` this search with no extra work, since the
  command is shared.

## 9. Questions for the owner

1. ~~**NEED-453**~~ — answered 2026-10-01: **A**. Who finishes the word index on a large file while max has no `store` commands:
   `messages search` a slice at a time plus `tg store migrate` (**A**, recommended), or only
   `tg store migrate` (**B**)?
2. ~~**NEED-454**~~ — answered 2026-10-01: **A**. Requirements §23's `search status|rebuild`: into the `store` group as
   `store info` / `store check` / `store reindex` (**A**, recommended), or a `search` group (**B**)?
3. ~~**NEED-455**~~ — answered 2026-10-01: **A**. Completeness per chat: from three facts, recording "reached the start" in
   `sync_state` (**A**, recommended), or from `sync_ranges` alone as the ruling is worded (**B**)?
4. ~~**NEED-456**~~ — answered 2026-10-01: **B**, inside phase 2 (S13). One search across accounts and messengers (requirements §7, `--source`): after
   phase 2, as its own item (**A**, recommended — the store's filter already takes several accounts;
   what is missing is naming and opening a chat of another messenger in the answer), or inside phase 2
   (**B**)?
