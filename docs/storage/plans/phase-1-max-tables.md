# The tables max-cli's personal data needs in the shared store

Plan, 2026-09-30. **Approved by the owner 2026-09-30 (NEED-419 A).** Owner, 2026-09-30 (NEED-396 A): built right after store
version 6, on today's hand-written SQL, before phase 1 items 7–8; those items move it to Drizzle with
the rest. Evidence labels as in [`phase-1.md`](phase-1.md): **verified** has a `path:line` or a
command; **inferred** is reasoning.

## 1. Goal

Everything max-cli's personal cache keeps (`max-cli/src/cache/schema.ts`) has a home in `messages.db`,
per account, behind `MessageStore`, so max-cli can move onto cli-messaging's services (max-cli
`docs_ai/plans/2026-09-30-layers.md` §4 step 6, NEED-407 A) and drop its own file. tg-cli gets the
same tables for free.

## 2. Current state

**The map is already agreed** — phase 1 §8, and max-cli's one-store plan R2. Verified against
max-cli's cache schema (`src/cache/schema.ts:20-205`) and today's store:

| max-cli cache | In `messages.db` today | Needed |
|---|---|---|
| `chats` + FTS | `chats`, `chats_fts` | a filter (text, kind, unread) and a count |
| `people` (`description`, `last_messaged_at`, `source`) | `identities` + `account_identities` | `description`; recency per account; contact paging |
| `chat_members (chat_id, person_id)` | — | **new table** |
| `sync_marker` (login delta), `fetched (kind, at)` | — | **new table** `sync_state` |
| `messages` by time | `messages`, `messages_by_time` | a window by time, a count since |
| `ranges (from_time, to_time)` | `sync_ranges (from_key, to_key)` — the provider's ordering key | nothing: for MAX the key is time in ms (phase 1 §8) |
| `fetch_lease` | — | **new table** `fetch_leases` |
| `messages.transcript` (and cli-messaging's own `transcripts-<profile>.db`) | — | **new table** `transcripts` (D5) |
| `max cache clear` (deletes the file) | — | `purge(account)` |

**The asker has changed.** max-cli's list of calls (FIND-281 in max-cli's journal) was written for a
`CacheStore` adapter. NEED-407 A replaced that adapter with max-cli moving onto cli-messaging's
services, so the services, not an adapter, call these methods. The shapes below follow the list;
they are confirmed with whoever builds layers step 6 before each PR (§6, Q1).

**Deleted messages (NEED-393 A):** a deleted message keeps its tombstone and loses its text — `text`
becomes `''`, `normalized_text` `NULL`, its `message_revisions` go — and a later sync does not bring
it back. Today `saveMessages` rewrites the text of a deleted row (verified, `src/store/store.ts:356-376`
at `979f0a6`).

**A deletion that names no chat is a guess (0.52.0, #150).** Telegram reports deletions in private
chats and basic groups by id alone. Since 0.52.0 `markDeleted` without a chat leaves out channels and
chats whose `chatType` numbers its own messages, and skips the deletion when more than one message
matches. A supergroup stored only as a stub (`kind = 'unknown'`, no metadata) is still not recognised.
Today a wrong match only hides a message; once deletion erases the text (D6), it destroys it.

## 3. Decisions

**D1 · One migration per table, numbered 7 to 11**, each in its own PR, announced in the lanes plan
first (one PR taking 7–11). Each is additive, so `min_compatible` stays 6: a version 6 build keeps
working on the file.

**D2 · Every table is keyed by account**, directly or through `chats`: a row written for one account
never answers another. Each method's test writes for two accounts.

**D3 · No transaction callback on `MessageStore`** (phase 1 D3). What must change together is one
method, with no MAX words in its shape so tg-cli's catch-up can use it too:
`applyDelta(key, { chats, people, members: Map<chatId, ids>, state?: Record<name, value> })`. MAX's
login marker is `state["login.marker"]`.

**D4 · Hand-written SQL now, as the rest of `store.ts`.** Items 7–8 port these with everything else;
writing them twice would cost more than it saves.

**D5 · Transcripts move into the shared store** (owner, 2026-09-30, NEED-418 B: «we move per-profile
cache to shared store»). cli-messaging 0.47 keeps them per profile in `transcripts-<profile>.db`
(`src/speech/hearing.ts:40-58`); they move to a table `transcripts (chat_pk, message_native_id, text,
source, heard_at)`, keyed by chat and message id rather than by a message row, because a message can
be heard before the store holds it. `markDeleted` removes a deleted message's transcript (NEED-393 A)
and `purge` removes an account's. The old per-profile files are not read again: a transcript can be
heard again, so the store starts empty and the files go to the cleanup list. A development build
stays off the owner's data because `bin/max` and tg's sandbox already point `MESSAGING_STORE`
elsewhere.

**D6 · Deletion as ruled (NEED-393 A) goes into `markDeleted` itself**, not a second method: the
ruling is about the shared store, so tg-cli's deletions follow it too, and one method means one
meaning. It comes here, not in item 8, because max-cli is the first caller that needs it.
It keeps 0.52.0's rule for a deletion that names no chat, and adds one: such a deletion also leaves
out chats of kind `'unknown'`. Erasing is not reversible, so a guess must not reach a chat whose kind
we do not know; a deletion missed there costs a message that should be hidden, not one that is lost.

**D7 · Names grouped by concern.** Chats: `chats`, `countChats`, `saveMembers`, `members`,
`chatsWith`. People: `contacts`, `countContacts`, `refreshRecency`. Sync: `syncState`,
`setSyncState`, `clearSyncState`, `claim`, `release`, `applyDelta`. Messages: `messagesWindow` (by
time) next to `around` (by id), which stays. They sit on the `MessageStore` facade for now; when the
store is split into repositories after phase 1 (NEED-406 B), each group moves whole, without a
rename.

## 4. Work items, in order

| # | Version | What | Methods |
|---|---|---|---|
| 1 | — | the lanes plan takes 7–11 | — |
| 2 | 7 | `chat_members (chat_pk, identity_pk)`, PK both, index by identity | `saveMembers(key, chatId, ids)` replaces a chat's membership whole; `members(key, chatId)`; `chatsWith(key, identityId)` newest first |
| 3 | 8 | `sync_state (account_pk, key, value, at)`, PK `(account_pk, key)` | `syncState(key, name)`, `setSyncState(key, name, value)`, `clearSyncState(key, name)` — the login marker, "list fetched at", a chat's "fresh" mark, and a chat's "history reaches its first message" mark, which `db doctor`'s completeness check reads (phase 1 item 9) |
| 4 | 9 | `fetch_leases (chat_pk, anchor, holder, expires_at)`, PK `(chat_pk, anchor)` | `claim(key, chatId, anchor, holder, forMs)` → whether this holder has it; `release(...)` |
| 5 | 10 | `identities.description`, `account_identities.last_messaged_at` (both nullable) | `contacts(key, { order: "recent" \| "name", query?, limit, offset })` + `countContacts`; `refreshRecency(key)` |
| 5b | 11 | `transcripts` (D5); `src/speech/hearing.ts` keeps and reads through the store instead of its own file | `transcript(key, chatId, messageId)` → `{ text, source }`; `keepTranscript(key, chatId, messageId, text, source)` |
| 6 | — | reads, no schema | `chats(key, { query?, kind?, unread? })` and `countChats`; `messagesWindow(key, chatId, { at, before, after })` by time, beside `around` by id; `messages(key, chatId, { since })` and `countSince` |
| 7 | — | deletion and purge | `markDeleted` as NEED-393 A (D6); `saveMessages` skips deleted rows; `purge(key)` deletes one account's rows everywhere, FTS kept by the triggers |
| 8 | — | `applyDelta` (D3) | one transaction over items 2, 3 and `saveChats`/`savePeople` |

Items 2–5b each release, since the services cannot use a method before it is published. Items 6–8
can share one release.

## 5. Tests

- Per method: two accounts, and a row for one never answers the other (D2).
- `saveMembers` twice: the second list replaces the first, and a person left out is gone.
- `claim`: a second holder is refused until the first expires or releases.
- `markDeleted`: the message is gone from `messages`, `around`, `message`, `find`, `chatStats` and the
  counts; its text, normalized text and revisions are gone from the file; `message_count` drops;
  `saveMessages` of the same id afterwards changes nothing.
- `markDeleted` without a chat: 0.52.0's test keeps passing, and a message in a chat of kind
  `'unknown'` keeps its text.
- `transcripts`: a message heard before it is stored keeps its transcript; `markDeleted` and `purge`
  remove it; `hearing.ts` answers a second hearing from the store without calling the recognizer.
- `purge`: one account's chats, messages, members, state, leases, transcripts and seen identities go; another
  account's and the FTS index of both stay consistent (`integrity-check`).
- The migration guards from item 4 cover each new version; the published 0.49.0 keeps opening a
  version 9 file (`min_compatible` 6) — aliased like the 0.13.0/0.27.0 test.

## 6. Open questions

**Q1 — answered 2026-09-30 by the max-cli session building layers step 6:** §4 fits the services,
with four changes, now in the plan: deletion inside `markDeleted` (D6), `applyDelta` without MAX's
words (D3), `messagesWindow` beside `around` rather than instead of it, and names grouped by concern
(D7). The services call the `MessageStore` facade until the repository split.

**Q2 — answered 2026-09-30 (NEED-418 B):** transcripts move into the shared store (D5).
