# Storage and search — what is ruled, what is open

The owner's requirements are [`requirements.md`](requirements.md). This page records where they
stand after the research, and the rulings. A ruling is quoted with its date; an open question names
its journal id (`NEED-nnn`, max-cli's private journal) and is closed here when answered.

## Ruled

| Date | Ruling |
|---|---|
| 2026-09-29 | **Drizzle** is the way to work with the database — schema, queries, generated migrations. |
| 2026-09-29 | **The store API is async**, "fully async where we can". |
| 2026-09-29 | **cli-messaging moves first**; max-cli then uses cli-messaging's store for its own cache, not the other way round. |
| 2026-09-29 | No Elasticsearch, OpenSearch, LanceDB or graph database in the initial architecture (requirements §2, §12). |
| 2026-09-30 | **Engine: SQLite FTS5**, built behind a store interface a Postgres backend could implement later (NEED-374 A). |
| 2026-09-30 | **Search requires every word, and falls back to any word when nothing is found** (NEED-375 A). **BM25 ranks, trigram typo matching corrects**: a word the corpus knows is used as typed; an unknown word gets candidates from a trigram index over the vocabulary, edit distance ≤ 2, and the search runs with the corrections (as in `bench/search/sqlite.ts`). |
| 2026-09-30 | **Keep the substring index over message text** (FTS5 `trigram`, as migration 5) next to the new word index: words with BM25 first, substring when words and typo correction find nothing. «I would implement it and then later, if we see that we don't need it, we can get rid of it» (NEED-379 A; phase 1 plan §9 Q2). |
| 2026-09-30 | **Store version 6 locks older builds out**: `min_compatible` 6, so a tg or max built before it refuses `messages.db` and asks to be upgraded; tg-cli and max-cli ship their upgrade the same day. «we need to make sure the stuff is in sync and force upgrade of clis» (phase 1 plan §9 Q1 B, D6; shipped in 0.49.0). |
| 2026-09-30 | **Phase 1 keeps today's column names** where §4–§5 of the requirements name the same field differently: a rename rebuilds the table, and a rebuild breaks every build already installed. The mapping is under [Names](#names-the-requirements-field-and-the-column-that-holds-it) (phase 1 plan D5). |
| 2026-09-30 | **No messenger-only tables.** What max-cli's cache needs and Telegram has too becomes a generic table (versions 7–11: chat members, sync state, fetch leases, contact recency, transcripts); the rest goes into `provider_metadata` (phase 1 plan D8). |
| 2026-09-30 | **`max` gets the store maintenance commands (`store info`, `check`, `migrate`, `backup`, `restore`) at the fold-in of its profile cache into `messages.db`, not before**: `max store` works on the profile cache until then, and one group over two files would confuse. Until then `tg store …` looks after the shared file (NEED-445 A). **Correction 2026-10-01:** NEED-476 A moved them into max's group 6 move (`messages.db` holds max's messages from then on); max has them since max-cli #307. |
| 2026-09-30 | **No daemon in phases 1–2**; the store is opened directly with WAL (NEED-376 A). Whether one is needed later: [`daemon.md`](daemon.md). |
| 2026-09-30 | **No daemon that owns the database, now or later.** `max serve` stays what it is — the daemon for MAX API requests — and does not become the database's owner. **Background workers are planned** for long jobs (sync, graph building, AI enrichment), from phase 3 on: they open the store like any command. See [`daemon.md`](daemon.md). |
| 2026-09-29 | Ordinary search never calls an API; AI enrichment only on explicit request, with cost limits (requirements §3, §14, §15, §29). |
| 2026-09-30 | **The CLI never calls an AI model to link messages. The user's own agent does it**, through a skill and CLI commands, only when the user asks: the CLI builds the free links (replies, threads, one sender's consecutive messages), hands out overlapping batches with candidate links, stores the links the agent returns with their source and model, then builds conversations, chunks and embeddings. Supersedes requirements §13 stage 3, §14 `--mode ai`, §15 cost estimates and §27 `ConversationInferenceProvider` (NEED-405). Owner: «not smth fully automatic - we would provide a skill and cli commands for ai agent to do this for the user». |
| 2026-09-30 | **Embeddings are computed locally**, by one small multilingual model, or a short list to choose from, in the folder the speech models already share between tg and max (`~/.cache/cli-common/models/`, `src/speech/install.ts`). Embeddings go on chunks, not on single messages, and are not used to link messages (NEED-412 A). |
| 2026-10-02 | **Phase 5: e5-small is the default embedding model**, EmbeddingGemma in the list for whoever accepts the Gemma terms (NEED-517 A); **vectors in a plain table scanned in JS, not sqlite-vec**, until a real archive outgrows it — replaces NEED-374 A's "sqlite-vec when phase 5 comes" (NEED-518 A); **the model runtime ships as our own small package** (`@leemour/cli-messaging-onnx`), nothing imported from the models folder (NEED-519 A). [Plan](plans/phase-5.md). |
| 2026-10-02 | **Embeddings may also come from an external API, with the user's own key**, on top of the local default — amends NEED-412 A; and **embedding runs in parallel** to go faster. Owner: «allow also using external embedding model by providing an api key to the tool … and using parallelization so we speed up the embeddings». [Plan](plans/phase-5.md) E11–E12. |
| 2026-10-02 | **The substring index ignores accents, as the word index does**, so `len` finds "València": `messages_fts` is rebuilt as FTS5 `trigram` over `normalized_text` (or with `remove_diacritics 1`), and the substring query is normalized the same way. It goes into the same migration as phase 5's store version 14, so a user waits through one rebuild, not two (max-cli NEED-521 A, from FIND-443). [Phase 5 plan](plans/phase-5.md) E8. |
| 2026-09-30 | **Phase 2 search takes a typed query language** — `from:` `chat:` `after:` `before:` `has:`, `"phrase"`, `-word`, `OR` — mapped onto the filters and FTS5, **and shows how complete the archive is for each chat searched**, from `sync_ranges` (NEED-400 A). **Refined 2026-10-01 (NEED-455 A):** from three facts — the newest message held against the chat's newest, gaps in `sync_ranges`, and a `sync_state` note that `store fetch` reached the chat's start. |
| 2026-10-01 | **Phase 2's word index is finished in pieces by `messages search` itself** (up to ~200 ms a call, normalization first) as well as by `store migrate`, so a max user without tg gets it before the fold-in (NEED-453 A; [phase 2 plan](plans/phase-2.md) S3). |
| 2026-10-01 | **No `search` command group**: requirements §23's `search status|rebuild` become `store info`, `store check` and `store reindex` (NEED-454 A; phase 2 plan S11). |
| 2026-10-01 | **Phase 2 searches across accounts and messengers on request**: `in:telegram` / `in:max` / `in:all` and `--source` read every such account held in `messages.db`; the default stays the current account (NEED-456 B; [phase 2 plan](plans/phase-2.md) S13). |
| 2026-10-01 | **The phase 2 plan is approved** ([`plans/phase-2.md`](plans/phase-2.md)); it is built after phase 1's lane A. |
| 2026-10-01 | **A chat the account left is marked, not deleted, and `store clear --left` deletes the marked ones** with their messages, members and sync state (max-cli NEED-488 B, NEED-496 B). The command is shared; tg gets it with store version 14, max with the other store maintenance commands at the fold-in — until then `max cache clear --left`. It asks for `--allow-dangerous`, as `messages delete` does: what it deletes cannot be fetched again. Plan: [`plans/chats-left.md`](plans/chats-left.md). **Correction 2026-10-01:** max got `store clear` with the maintenance commands, in group 6 (max-cli #307), since its left chats' messages live in `messages.db` from then on; `max cache clear --left` still clears the old cache. Open for the owner: NEED-510. |
| 2026-09-30 | **Phase 1's `db doctor` also reports completeness per chat**: chats whose history does not reach their newest message, and how long ago each chat was refreshed; plus `PRAGMA foreign_key_check` (NEED-399 A; plan item 9). |

## Answered — the evidence behind the rulings above

NEED-374 (engine), NEED-375 (search semantics), NEED-376 (daemon) were open with the comparison
below; the owner answered A, A, A on 2026-09-30.

### NEED-374 · The engine: SQLite FTS5, PGlite, or Postgres by URL?

The requirements (§2, §7, §8, §25) name PGlite with `pg_textsearch`, `pg_trgm`, `unaccent`, and
optional pgvector. The research points the other way:

| | SQLite FTS5 | PGlite 0.5.8 | Postgres (native) |
|---|---|---|---|
| typical query at 1M, p95 | ≤ 25 ms, any filter | up to 298 ms (small chat) | up to 150 ms (small chat) |
| disk / memory at 1M | 806 MB / 154 MB | 1.63 GB / 858 MB | 1.66 GB / 328 MB |
| BM25 | built in (`bm25()`) | `pg_textsearch` (no phrase, no fuzzy; returned non-matching rows under a chat filter) | `pg_textsearch` |
| typos | vocabulary + trigram + edit distance (100% recall on the four examples) | `pg_trgm` (100%) | `pg_trgm` (100%) |
| several processes | safe (WAL, `busy_timeout`) | **none** — two processes corrupt the directory silently; needs a daemon and our own lock | safe, but a server to install and run |
| upgrades | file format stable | **dump and restore on every minor PGlite version** | normal Postgres upgrades |
| vectors (phase 5) | sqlite-vec (alpha) | pgvector | pgvector |
| Drizzle | `node:sqlite` driver only in drizzle-orm **1.0 rc**; FTS5 in a custom migration | stable driver; extensions in a custom migration | stable driver |

Evidence: [`research/2026-09-29-search-benchmark.md`](research/2026-09-29-search-benchmark.md),
[`research/2026-09-29-pglite-measured.md`](research/2026-09-29-pglite-measured.md),
[`research/2026-09-29-pglite-web-check.md`](research/2026-09-29-pglite-web-check.md),
[`research/2026-09-29-drizzle.md`](research/2026-09-29-drizzle.md).

- **A** SQLite FTS5, sqlite-vec when phase 5 comes.
- **B** PGlite behind a daemon, as the requirements say.
- **C** SQLite by default, Postgres by connection URL later, behind one store interface.

Recommended: **A, built with C's interface** — the only engine that meets "interactive" at 1M with
filters, at half the disk and a fifth of the memory, with no daemon required for safety; the store
interface keeps a Postgres backend possible if a real limit is hit.

### NEED-375 · Default search semantics: every word, or any word?

With every word required, SQLite answers ≤ 25 ms p95 at 1M under any filter; ranking by any word
(what `pg_textsearch` does) misses 100 ms on every engine once a filter is added.
**A** every word, fall back to any word when nothing is found · **B** always any word.
Recommended: **A**.

### NEED-376 · A daemon that alone opens the database — from phase 1?

Requirements §2 and §29.10 route all database access through a daemon. With SQLite this is not needed
for safety, and it is the largest piece of work: a data protocol (none exists — `max serve` proxies
MAX, `tg serve` has no socket, see [`current-state.md`](current-state.md)), auto-start, idle, a lock,
"another version gives way" across two separately released CLIs, and a path for `--offline`,
completion, doctor, bot commands and tests.
**A** phases 1–2 without a daemon, store opened directly (WAL); the daemon as its own phase when sync
or enrichment needs it · **B** daemon first, as written.
Recommended: **A**.

## Names: the requirements' field and the column that holds it

Phase 1 plan D5. Only the fields whose name differs; the full table, with what phase 1 added, is
[plan §4](plans/phase-1.md#4-45-against-the-schema).

| Requirements (§4–§5) | Column |
|---|---|
| `messages.id`, `chats.id` | `pk` |
| `source` | `accounts.provider`, through `account_pk` |
| `source_message_id`, `source_chat_id` | `native_id` |
| `account_id`, `chat_id`, `sender_id` | `account_pk`, `chat_pk`, `sender_identity_pk` (+ `sender_chat_native_id`) |
| `reply_to_message_id` | `reply_to_native_id`, the provider's id; a link to our own row is phase 3 |
| `forward_source` | `forward` (JSON) |
| `created_at`, `updated_at` | `ingested_at`, `edited_at` |
| `raw_metadata` | `provider_metadata` |
| chat `name`, `type` | `title`, `kind` |

Not stored: `quoted_message_id` and `topic_id` (phase 3; `thread_native_id` exists),
`first_message_at` and `last_message_at` (an index lookup over `messages_by_time`; the chat's
`last_message_at` column is the provider's value), `last_indexed_at` (phase 2, with its index).

## Consequences

- The requirements' message and chat models (§4, §5) replace today's schemas: internal ids separate
  from provider ids, `normalized_text`, `membership_state`, `is_searchable`, `raw_metadata`.
  **Correction 2026-09-30:** they do not replace them — version 6 added `normalized_text`,
  `membership_state`, `is_searchable` and `message_count`, and every other field maps onto a column
  that already existed ([Names](#names-the-requirements-field-and-the-column-that-holds-it)).
- max-cli's cache tables that cli-messaging lacks (`chat_members`, `sync_marker`, `fetched`,
  `fetch_lease`, transcripts, recency) move into cli-messaging's schema or stay max-specific tables in
  the same database — decided in the phase 1 plan, not here. **Correction 2026-09-30:** decided —
  generic tables, versions 7–11 (ruling above); recency lives in `account_identities`.
- Normalization folds ё→е and й→и explicitly: `unicode61 remove_diacritics` strips Latin accents only.
- Filters are the performance problem, not ranking: the phase 2 plan must say how chat, sender and
  date filters reach the full-text index (the benchmark's small-chat rows; a small chat inside 10M is
  unmeasured, estimated 150–250 ms for SQLite).
