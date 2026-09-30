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
| 2026-09-30 | **Keep the substring index over message text** (FTS5 `trigram`, as migration 5) next to the new word index: words with BM25 first, substring when words and typo correction find nothing. «I would implement it and then later, if we see that we don't need it, we can get rid of it» (NEED-379 A). |
| 2026-09-30 | **No daemon in phases 1–2**; the store is opened directly with WAL (NEED-376 A). Whether one is needed later: [`daemon.md`](daemon.md). |
| 2026-09-30 | **No daemon that owns the database, now or later.** `max serve` stays what it is — the daemon for MAX API requests — and does not become the database's owner. **Background workers are planned** for long jobs (sync, graph building, AI enrichment), from phase 3 on: they open the store like any command. See [`daemon.md`](daemon.md). |
| 2026-09-29 | Ordinary search never calls an API; AI enrichment only on explicit request, with cost limits (requirements §3, §14, §15, §29). |
| 2026-09-30 | **The CLI never calls an AI model to link messages. The user's own agent does it**, through a skill and CLI commands, only when the user asks: the CLI builds the free links (replies, threads, one sender's consecutive messages), hands out overlapping batches with candidate links, stores the links the agent returns with their source and model, then builds conversations, chunks and embeddings. Supersedes requirements §13 stage 3, §14 `--mode ai`, §15 cost estimates and §27 `ConversationInferenceProvider` (NEED-405). Owner: «not smth fully automatic - we would provide a skill and cli commands for ai agent to do this for the user». |
| 2026-09-30 | **Embeddings are computed locally**, by one small multilingual model, or a short list to choose from, in the folder the speech models already share between tg and max (`~/.cache/cli-common/models/`, `src/speech/install.ts`). Embeddings go on chunks, not on single messages, and are not used to link messages (NEED-412 A). |
| 2026-09-30 | **Phase 2 search takes a typed query language** — `from:` `chat:` `after:` `before:` `has:`, `"phrase"`, `-word`, `OR` — mapped onto the filters and FTS5, **and shows how complete the archive is for each chat searched**, from `sync_ranges` (NEED-400 A). |
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

## Consequences

- The requirements' message and chat models (§4, §5) replace today's schemas: internal ids separate
  from provider ids, `normalized_text`, `membership_state`, `is_searchable`, `raw_metadata`.
- max-cli's cache tables that cli-messaging lacks (`chat_members`, `sync_marker`, `fetched`,
  `fetch_lease`, transcripts, recency) move into cli-messaging's schema or stay max-specific tables in
  the same database — decided in the phase 1 plan, not here.
- Normalization folds ё→е and й→и explicitly: `unicode61 remove_diacritics` strips Latin accents only.
- Filters are the performance problem, not ranking: the phase 2 plan must say how chat, sender and
  date filters reach the full-text index (the benchmark's small-chat rows; a small chat inside 10M is
  unmeasured, estimated 150–250 ms for SQLite).
