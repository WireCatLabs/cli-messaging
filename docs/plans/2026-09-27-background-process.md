# The background process — plan for PR 2.3

**Status 2026-09-27: a plan, nothing built.** Proposal §8 row 2.3: "the background process (`serve`)
from max-cli's `src/server/`; the Telegram adapter supplies the connection and ingests updates (new,
edit, delete, reaction)".

## 1. Why it exists — and why it is smaller than max-cli's

max-cli's server (`../max-cli/src/server/`, about 1,000 lines) exists mainly so **every command
shares one logged-in connection**: MAX counts logins and can tell one client from another, so a login
per command is a risk to the account. Commands talk to it over a Unix socket.

Telegram has no such constraint. Sessions are long-lived, and two processes on one session work —
measured 2026-09-27: `tg account show` ran during a `tg watch` on the same session file. So for tg,
**commands stay one-shot and never route through the server.** What the server is for:

- **Keeping the archive current without a terminal open.** `backfill` fetches the past; only a
  listening connection sees what happens next.
- **Edits, deletions and reactions.** They arrive only as live updates. The store already keeps
  revisions (`saveMessages`) and tombstones (`markDeleted`, from #10).

## 2. What gets built, in two PRs

**2.3a — `watch --events`, in the foreground.** The port's `watch` becomes a listener for four kinds
of update, and each is saved:

| Update | mtcute (0.32.3) | Store |
|---|---|---|
| new message | `onNewMessage` | `saveMessages` via `update` (as today) |
| edit | `onEditMessage` | `saveMessages` — keeps the old text as a revision |
| deletion | `onDeleteMessage` | `markDeleted` — ids only, and in private chats without a chat id |
| reactions | **no named event for personal accounts** — raw `updateMessageReactions` | `saveMessages` with the new reactions |

Reactions are the unknown: read the raw update's shape live before designing their mapping. With
`--events`, every line names its event (`{"event": "message", …}`), as max-cli's `watch` does; without
it, the stream stays bare messages.

**2.3b — `tg serve`.** The same listener with no output but a log, run until stopped:

- **One per account**, by a lock file beside the session (a PID and a start time), not a table row —
  no migration for it. A second `serve` refuses with the PID it found.
- **Catch-up on**: an archiver must not lose what arrived while it was down. mtcute catches up on
  start; duplicates are harmless because the store upserts. **Measure the first catch-up** on the
  owner's account (1,351 chats) before trusting it — it may take long or hit FloodWait.
- **Started by a person or by the system, never by another command.** A systemd user unit and a
  launchd plist go in the README. max-cli starts its server from commands because commands need it;
  tg's commands do not.
- `tg serve status` answers from the lock file and the store's last `update` time.

## 3. What will bite

- **`disableUpdates` is per connection.** One-shot commands keep it on; only `watch` and `serve` listen.
- **mtcute warns that a storage not closed properly makes catch-up repeat updates.** `serve` must
  close on SIGTERM as `watch` does on Ctrl-C.
- **Telegram's delete updates for private chats and basic groups carry message ids without a chat**
  (proposal §4). `markDeleted(key, ids)` already handles that, by account.
- **`watch` prints "listening" before the updates loop runs** (HANDOFF, small items). Fix it in 2.3a
  with an `onReady` callback on the port.

## 4. Decision for the owner

- **NEED-9 — should `tg serve` start by itself?** Recommended: no. A person starts it, or a systemd
  or launchd unit does; no command ever spawns it. max-cli auto-starts because its commands need the
  server, and tg's do not. If unanswered: built this way, and a `serve` setting can be added later.
