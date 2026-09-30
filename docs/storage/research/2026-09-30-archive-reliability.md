# Archive reliability: tg-archive and Telegram-Archive against our store

Date: 2026-09-30. Read-only study. No message content from anyone is quoted here.

Sources read:

- `tggo/tg-archive` at `47b9d4cab8c148e86cf754235f817ad4e69ba124` (Go, gotd, SQLite, MCP).
- `GeiserX/Telegram-Archive` at `0b38d787f9231e0c439dd465a9b4cd45dc26f541` (Python, Telethon, SQLAlchemy, SQLite or Postgres, web viewer).
- gotd `v0.161.0` (`telegram/updates/config.go`, `manager.go`), the version tg-archive pins.
- Ours: cli-messaging `a71957f` (`src/store/migrations.ts`, `src/store/store.ts`, `src/cli/messenger/backfill-command.ts`), tg-cli `f15aa62`.

Labels: **code** = read in source at the commit above. **docs** = a README or documentation page says it.
**inferred** = my reasoning from the code, not run.

## 1. What matters for us

1. **Our range comment is wrong for Telegram private chats and basic groups.**
   The comment on `sync_ranges` says "A message missing from inside one was deleted" (**code**, cli-messaging
   `src/store/migrations.ts:196-197`). Telegram numbers messages per account in private chats and basic groups.
   Only supergroups and channels number per chat (**code**, tg-archive `CLAUDE.md:38-41`, `store.go:574-590`;
   Telegram-Archive `db/adapter.py:1896-1905`). So most ids missing from a private-chat range belong to other
   chats. Ids of service messages that an adapter drops also fall inside ranges (**inferred**).
   What a range still proves: "every message this chat had in this span, at fetch time, is held." That is the
   right meaning for "no result" against "not archived". It is not proof that an absent id was deleted.
   Whether MAX numbers messages per chat is not known. Do not guess it (see §6).
2. **A deletion that names no chat can tombstone the wrong message.**
   `markDeleted` without `chatId` updates every row in the account with that id, channels included (**code**,
   `store.ts:661-676`). Telegram sends peerless deletes only for private chats and basic groups. Channel and
   supergroup ids are a separate id space, so a peerless delete must never touch a `-100…` chat.
   Telegram-Archive had this bug and fixed it: it excludes chats below `SUPERGROUP_ID_CEILING` and skips
   the delete when more than one chat matches (**code**, `db/adapter.py:1890-1924`, `listener.py:1156-1180`).
   tg-archive still has it: `FindChatByMessage` is `WHERE id=? LIMIT 1` with no filter (**code**, `store.go:250-257`).
   Today no caller passes a delete without a chat: tg-cli never calls `markDeleted`, and max-cli's bot passes
   `chatId` (**code**, `max-cli/src/bot/keep.ts:94`). It becomes a bug when tg-cli wires live deletes.
   Note: tg-cli writes `kind = "group"` for both basic groups and supergroups (**code**, tg-cli
   `src/telegram/map.ts:121-125`), so the store cannot filter by `kind`. It needs the id space, from
   `provider_metadata.chatType` or from the marked id (**inferred**).
3. **Ranges go stale and nothing re-checks them.** A range records what was complete when it was fetched.
   Backfill jumps over held ranges (`before = held.from`, **code**, `backfill-command.ts:293-298`), so a message
   deleted or edited after its page was fetched is never seen again unless a live update arrives. Telegram-Archive
   re-reads every stored id in batches of 100 to find deletes and edits (opt-in, **code**,
   `telegram_backup.py:2671-2785`). tg-archive has no such pass (**code**, nothing in `internal/`).
4. **"Reached the start of history" is not stored.** Backfill computes `complete: reachedStart && ranges.length === 1`
   only in its return value (**code**, `backfill-command.ts:278-308`). The range's `from_key` is the oldest id
   seen, not "nothing older exists". So after the run, the store cannot say whether an empty answer before the
   oldest message means "none" or "never fetched". tg-archive keeps `state.backfill_done` (**code**, `store.go:40-45`).
5. **Stale edits can overwrite newer text.** Our upsert writes a revision and replaces the text whenever the text
   differs, with no check of `edited_at` order (**code**, `store.ts:369-387`). An older copy (a slow page, an
   out-of-order event) can win. Telegram-Archive applies an edit only when its `edit_date` is not older than the
   stored one, and never on a date-less copy of an edited row (**code**, `db/adapter.py:728-750`).
   What we already do right: a reaction-only change does not create a revision, because we compare text
   (**code**, `store.ts:378`). Telegram bumps `edit_date` on reaction-only changes (**code** comment,
   Telegram-Archive `db/adapter.py:739-745`). A partial copy never erases a field: `coalesce(?, column)`
   (**code**, `store.ts:369-375`). Telegram-Archive needed the same rule after a bug (**code**, `adapter.py:385-426`).

## 2. tggo/tg-archive

Small and honest. About 4,400 lines of Go.

**Schema** (**code**, `internal/store/store.go:13-76`). `messages` has `PRIMARY KEY (chat_id, id)`, a `deleted`
flag, one `edited` date, and text overwritten in place. No edit history. `state(chat_id, min_id, max_id,
backfill_done)` is the only sync cursor: one interval per chat. Chat ids are Telethon "marked" ids
(user > 0, basic group = -id, channel = -100…) (**code**, `CLAUDE.md:30-32`).

**Backfill** (**code**, `internal/tgclient/backfill.go:61-94`). Walks back from `state.min_id` with `GetHistory`.
It sets `backfill_done` only when a run with no limit ends without error. `GetHistory` has no min id, so
"newer than X" iterates newest-first and stops early (**code**, `backfill.go:38-42`, `CLAUDE.md:48-49`).

**Update gaps.** tg-archive does not handle pts/qts/seq itself. It passes updates to gotd's `updates.Manager`
with no `Storage` (**code**, `live.go:41`). gotd then keeps state in memory (**code**, gotd
`telegram/updates/config.go:87-88`). With no stored state, gotd calls `UpdatesGetState` on start
(**code**, gotd `manager.go:216-240`). Consequence (**inferred**): the process gets gap recovery while it runs,
but changes made while it was down are not fetched with getDifference. The backstop is `resyncLoop`: every 10
minutes it fetches messages newer than `max_id`, for the chats listed when `live` started (**code**,
`live.go:19`, `live.go:187`, `live.go:220-240`). Edits and deletes made while it was down are never recovered
(**inferred**).
Possible hole (**inferred**): a live message bumps `max_id` (`store.go:264-270`) before the resync runs. The resync
then fetches only above it, so messages sent while the process was down, below that id, are skipped. In
channels `doctor` finds this if the hole is over 50 ids. In private chats nothing finds it.

**Edits and deletes.** An edit is the same upsert as a new message (**code**, `live.go` `onEdit`). A delete sets
`deleted=1`. Any later upsert sets `deleted=0` again, so a re-fetch brings a deleted message back
(**code**, `store.go:215-223`).

**FTS** (**code**, `store.go:54-69`, `174-201`). External-content FTS5, `unicode61 remove_diacritics 2`,
`content_rowid='rowid'` on a table without an INTEGER PRIMARY KEY. The update trigger fires on any column,
so a reaction change re-indexes the text. `ensureFTS` does not trust `COUNT(*)` on the FTS table. With external
content it counts the source table, so an empty index looks full. It uses a `meta.fts_version` flag plus
`messages_fts_data` rows (**code**, `store.go:174-201`; `CLAUDE.md:45-47`). A query FTS5 cannot parse falls back
to `LIKE` (**code**, `store.go:494-500`).

**Doctor** (**code**, `cmd/tg-archive/main.go:290-348`, `store.go:562-631`). Two checks:
- `Unfinished`: chats with messages whose `backfill_done` is 0. This is its completeness check for private chats.
- `Gaps`: `LAG(id)` jumps over `--min-gap` (default 50), only for `chat_id < -1000000000000`. The comment says the
  first version reported 8,195 false holes before this filter (**code**, `CLAUDE.md:38-41`).
- `--fix` fetches each hole between its two ids (**code**, `media.go:217-223`). No check of the schema,
  FTS integrity, or the database file.

**MCP** (**code**, `internal/mcpserver/server.go:43-100`). Tools: `list_chats`, `read_chat`, `search_messages`,
`archive_status`, `sync_chat`, `download_media`, `check_archive`, and `send_message` only with `--allow-send`.
Read tools are marked read-only. Search with no hits answers the text "no matches" (**code**, `server.go:301`).
Coverage is only in the separate `check_archive` tool. It does not tell "no result" from "not archived".

## 3. GeiserX/Telegram-Archive

Large (the backup module alone is 5,000 lines). Many fixes carry an issue number and a long reason comment.

**Schema** (**code**, `telegram_archive/db/models.py`). `messages` key is `(account_id, chat_id, id)`, with
`is_deleted` + `deleted_at` tombstones, `edit_date`, `sender_name` (added in migration 020, "immutable per-message
sender name snapshots"), `reply_to_top_id` for forum topics, and `raw_data` JSON for extras.
`message_versions` keeps old text, deduplicated by a unique `change_hash` = SHA-256 of
`{chat_id, message_id, text, date}`. The hash encoding is called a "FROZEN CONTRACT" (**code**, `adapter.py:437-456`).
`reactions` has one row per emoji and user, with `removed_at` tombstones. `forum_topics`, `avatar_history`,
`chat_folders` exist. No MCP server (**code**, grep finds only a comment).

**Sync cursor** (**code**, `telegram_backup.py:2218-2445`). One high-water id per chat (`sync_status.last_message_id`).
It walks forward from it, oldest-first, and checkpoints every N batches, so a crash re-fetches only since the
last checkpoint.
**A message that fails to process stops the cursor.** The failure is counted across runs in the metadata table.
After 2 failed runs the cursor passes it, and the id is written to a "given up" record first. The
comment says a skip must never be silent (**code**, `telegram_backup.py:150-153`, `2145-2216`, `2285-2345`).

**Update gaps.** No pts, getDifference or `catch_up` anywhere (**code**, grep). The listener docs say to run the
scheduled backup next to it "for complete coverage" (**code**, `listener.py:2014`). What Telethon does on
reconnect was not checked.

**Gap fill** (**code**, `adapter.py:4014-4047`, `telegram_backup.py:2479-2669`). `LAG(id)` jumps over
`GAP_THRESHOLD` (default 50), per account. There is **no chat-type filter**, so private chats get the false holes
that tg-archive filters out (**inferred** from the query). A hole before the oldest stored id is reported, never
fetched. The reason given: groups with hidden pre-history make that range impossible to fetch (**code**,
`telegram_backup.py:2601-2621`). Off by default (`FILL_GAPS`, **code**, `config.py:945-946`).

**Deletes and edits.**
- Live delete: see §1.2. A delete-rate limiter (10 per chat per 30 s by default) blocks mass deletes from
  wiping the archive (**code**, `listener.py:74-110`). Live deletes are off by default (`LISTEN_DELETIONS`).
- Reconcile pass: `get_messages(ids=batch)`; `None` means deleted. If the response does not line up one-to-one
  with the ids asked, unmatched ids are treated as unknown and nothing is deleted (**code**, `telegram_backup.py:2699-2730`).
- A re-fetch never clears a tombstone: `is_deleted`/`deleted_at` are written only when the new data says deleted
  (**code**, `adapter.py:419-426`).
- Edit apply returns `applied`, `noop` or `not_found`, so counters stay honest (**code**, `adapter.py:1957-1970`).

**Other Telegram edge cases in code.**
- Group → supergroup migration: the live handlers never see it, so the scheduled sweep detects it from the dialog
  list and from a stored service marker. The new id is followed, or a warning repeats every run (**code**,
  `telegram_backup.py:797-830`).
- Forum topics: the topic id is `reply_to_top_id`, else `reply_to_msg_id` when `forum_topic` is set. A
  topic-creation message is its own topic. General has no `reply_to` (**code**, `message_utils.py:930-953`).
- Albums: `grouped_id` stored as a string in `raw_data`. A script fixed old integer values, because JavaScript
  compared `"123"` to `123` as unequal (**code**, `listener.py:1321-1323`, `scripts/normalize_grouped_ids.py`).
- Reactions: a "min" reaction payload can leave out your own reaction, so it is never used to delete reactions
  (**code**, `telegram_backup.py:2764-2773`). Telegram does not reliably push reactions made on another device
  (**docs**, `docs/configuration/listener.md:94`).
- Media dedup: SHA-256 `content_hash`; one file in `_shared/` with symlinks (**code**, `models.py:468`,
  `telegram_backup.py:3543-3620`). A `skip_reason` (`oversize`, `filtered`) says why a file will never download
  (**code**, `models.py:472-478`).

**FTS** (**code**, `db/fts.py:21-40`, `92-108`). Same external-content FTS5 as tg-archive, but the update trigger
fires only on `text`. Queries are cut to word characters and every word becomes a quoted prefix, so users
cannot inject FTS5 operators. Also `content_rowid='rowid'` on a composite-key table.

**Health, not integrity** (**code**, `status.py`). `status` reports: no backup ever started, last backup did not
finish, the schedule missed a run, listener liveness, media counts, database size. It checks runs, not data.

## 4. What to borrow

1. **Peerless delete rule** (§1.2): exclude the channel/supergroup id space; skip on more than one match.
2. **Edit order rule**: apply a text change only when `edited_at` is not older than the stored one. Keep our
   text comparison, which already ignores reaction-only edits.
3. **Reconcile pass with a misalignment guard**: re-read stored ids in batches, tombstone only on an unambiguous
   "gone". Record when a range was last verified (a `verified_at` column), so "held completely" has a date.
4. **Store the start of history**: when backfill reaches the start, extend the range to the lowest possible key or
   set a flag. Report a missing start (hidden pre-history) but never fetch it in a loop.
5. **Answer searches with coverage.** Neither project does this. Our ranges can: a search or read in one chat
   can say "held from X to Y, last verified at T", so an empty answer is not read as "never said".
6. **Doctor checks**, from both:
   - completeness per chat: backfill never reached the start; ranges with holes between them;
   - an id-jump check only where ids are per chat (channels, supergroups, and MAX if confirmed);
   - FTS: do not trust `COUNT(*)` on an external-content index (**code**, tg-archive `store.go:179-181`). FTS5 has
     an `'integrity-check'` command (**docs**, sqlite.org FTS5 page, not tried here);
   - `PRAGMA integrity_check`, schema version, WAL size (**inferred**, standard SQLite).
7. **Poison-message rule**: a message that fails to map must not stop a chat forever. Count failed runs, give up
   after N, and write the given-up id before moving on. For us: the range must not cover a message we failed to store.
8. **Revision dedup key**: `message_revisions` has no unique key (**code**, `migrations.ts:127-133`). A hash of
   (message, text, edited_at) stops duplicate rows when two CLIs or two passes see the same edit.
9. **Mass-delete brake** for live deletes, as a safety net for the owner's archive.

## 5. What to avoid

1. `content_rowid='rowid'` on a table without an INTEGER PRIMARY KEY (both projects). SQLite says VACUUM may
   change such rowids (**docs**, sqlite.org VACUUM page). Then the index points at the wrong rows. Our
   `pk INTEGER PRIMARY KEY` is safe; keep it.
2. An FTS update trigger on every column (tg-archive). Ours is `AFTER UPDATE OF text`; keep it.
3. An upsert that clears a tombstone (tg-archive `deleted=0`).
4. Id-gap alarms in chats whose ids are per account (Telegram-Archive has no filter).
5. A single high-water cursor per chat (both). It cannot say which middle stretches are held. Our ranges can.
6. Live update state in memory only (tg-archive via gotd's default). If tg-cli adds a live listener, persist
   pts/qts/seq and per-channel pts, or run a reconcile after every restart.
7. Destructive writes on ambiguous API answers.

What we already do better (**code**): ranges remember a stretch checked and found empty, where both projects
re-scan the same hole on every run; edit history exists (tg-archive has none); text ids avoid 64-bit precision
loss (Telegram-Archive needed a data fix for `grouped_id`).

## 6. Open questions

1. Does MAX number messages per chat or per account? This decides whether an id jump can mean "missing" in MAX.
   Needs a capture of two chats, not a guess.
2. Do MAX message ids grow with time inside a chat? Backfill already refuses ids that are not safe integers
   (**code**, `backfill-command.ts:285-287`), but not ids that are out of order.
3. How should the store know the id space: a new column, a rule on `provider_metadata.chatType`, or the marked id?
4. Should `markDeleted` without a chat refuse, or apply the channel exclusion and the "exactly one match" rule?
5. How often, and in which chats, should a reconcile pass run? It costs one request per 100 stored messages.
6. Where to store "reached the start": a range down to key 0, or a column on `chats`?
7. Does tg-cli (mtcute) keep pts between runs, and does anything catch up after a restart? Not checked here.
