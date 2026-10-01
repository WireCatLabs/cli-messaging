# Chats the account has left — store version 14

Plan, 2026-10-01. It applies the owner's ruling for max's cache (max-cli NEED-488 B: **a chat the
account left is marked, not deleted**) to the shared store. Built in max-cli #285 for max's own
cache. **Waits for version 13 ([#255](https://github.com/leemour/cli-messaging/pull/255)) on `main`**:
the runner skips every version at or below the file's (`src/store/migrations.ts:314`).

Evidence labels as in the rest of this folder: **verified** has a `path:line` at `591a5e2`;
**measured** is a run against the real messenger.

## 1. Goal

`tg chats list --offline`, `max chats list --offline`, `chats show --offline` and the shared-chats
lookup stop answering with a chat the account is no longer in. Its row, members and messages stay:
the store is a system of record.

## 2. What is true now

- **Measured** (max, 2026-10-01): a full MAX login does not carry a chat the account has left; a chat
  it is in has `status: "ACTIVE"`.
- **Verified:** chats reach the store in one place. `stored.ts:58-62` wraps the adapter's `chats` and
  calls `saveChats(account, page.items)`. `chats`, `countChats` and `chatsWith` read them back
  (`src/store/store.ts:107-114`), and nothing ever marks or removes a chat.
- **Verified:** max-cli #285 makes max's adapter leave a chat out of its answer once max's cache knows
  it was left. tg's adapter walks the dialogs Telegram returns, which do not include a chat the
  account has left (inferred from Telegram's dialog semantics, not measured here).

## 3. Design

1. **Version 14, additive:** `chats.left_at integer`, nullable. `min_compatible` stays at 6, so
   older builds keep writing.
2. **`saveChats` clears the mark** of every chat it writes: a chat that comes back has been
   rejoined.
3. **`markChatsLeft(key, present)`:** sets `left_at` on this account's chats that are not in
   `present` and not marked yet.
4. **When it runs:** in `stored.ts`, only after a page that names every chat: offset 0 and `hasMore`
   false. The adapter's window carries only `limit` and `offset` (`port.ts:96`); filters are applied
   above it. A later page or a cut list says nothing about absent chats. This is the same rule for
   tg and max, so no CLI needs its own code.
   ⚠ **Inferred risk, max only:** right after `max cache clear` or a cache upgrade, a login cut short
   (more chats than one `CHATS_LIST` returns) answers fewer chats than the store holds, and the
   complete-looking page marks the rest. The mark is undone by the next save of that chat, so the
   worst case is a chat missing from `--offline` lists until the next full read.
5. **Reads skip marked chats:** `chats`, `countChats` and `chatsWith`. Messages of a left chat stay
   readable by its id (`messages list <id> --offline` reads messages, not the chat list).

## 4. Not in this plan

- **Deleting left chats from the store.** max has `max cache clear --left` for its own cache. A
  shared `store clear --left` would be a new command in both CLIs, and deleting from the system of
  record is the owner's call. It is asked separately.
- **Messages of a chat whose row is gone** (after a max cache upgrade). These are max-cache only;
  they are not in this store.

## 5. Work

1. Take version 14 in [the lanes plan §4](../../plans/2026-09-29-parity-lanes.md#4-releases-while-lanes-run).
   This PR does it.
2. After #255 merges: the migration through the Drizzle schema (`pnpm db:generate`), plus the store
   methods and reads. One PR, with a release.
3. tg-cli and max-cli take the release. Nothing else changes in them.

## 6. Tests

- **Store:** a mark survives a reopen; `saveChats` clears it; `chats`, `countChats` and `chatsWith`
  skip a marked chat; its messages stay readable; the mark is per account.
- **`stored.ts`:** a complete page marks; a page with an offset or `hasMore` does not.
- **Migration:** a version-13 file with chats opens at 14 with every `left_at` null.
- **Live, with the owner's yes:** `max chats list --offline` and `tg chats list --offline` no longer
  show a chat the account left.
