# Changelog

Notable changes to `@leemour/cli-messaging`, one section per version, newest first. Versions follow
[semver](https://semver.org/); before `1.0.0` a minor version may break callers, and says how under
"Changed — may break callers". `pnpm docs:check` checks the shape of this file.

## Unreleased

## 0.40.0 — 29.09.2026

### Changed — may break callers

- **`serviceCommand` is now `serverCommand`: `server start|stop|restart|status|logs|install|uninstall`**,
  the words max-cli's `server` uses. `service …` and `serve status` are gone: `server status` answers for
  both — whether serve runs, since when, whether it is listening yet, who started it (`unit`, `server` or
  `hand`) and the unit if there is one. `ServiceSystem` is `ServerSystem`, with `spawn` and `pause`.
  Unit names are unchanged, so a unit written by `service install` is still found.
- **`Defaults`, what an MCP tool's `online` receives, carries `settings` and `env`.** A CLI that
  builds its own tools from `tool()` and calls them directly must pass both.
- **`@leemour/cli-messaging` now depends on `sherpa-onnx` and `ogg-opus-decoder`** (about 15 MB of
  WebAssembly). Both are loaded only when a model runs.

### Added

- **`messages list --after <id-or-time>`**, max-cli's, and `after` on the `messages_list` tool: the
  oldest messages newer than a message id or a moment, for reading a chat forward. Digits are a
  message id — exact within one chat — anything else a time (ISO 8601, `2h`, `1d`). `--before` with
  `--after` is exit 2, and so is `--after` offline. A messenger offers it with the optional
  `historyAfter` (type `After`); without it the command says it cannot read forward.

- **`chats list --search <text> --kind <kind> --unread`**, max-cli's, and `search`, `kind` and
  `unread` on the `chats_list` tool. The filters combine; `--search` takes at least 3 characters and
  matches the chat's name. A filtered list searches the newest 200 chats — paging through every chat
  hit Telegram's rate limit once — and says so, `partial: true` on the tool, when older ones exist.
  Offline it searches every stored chat.
- **`server start` runs `serve` in the background when no unit is installed**, as its own process with a
  log in `<state>/serve/<profile>.log`, and answers only once `serve` is listening — the lock now records
  `listeningAt`. With a unit it goes through systemd or launchd. `server stop` signals only a serve that
  `server start` started (its environment says so); one started by hand is named and left alone.
- **Sentences for a person** from every `server` subcommand; `--json` keeps the data.
- **Speech recognition on this machine, shared by every messenger CLI.** `modelsCommand(messenger)`
  adds `models audio list|download <id>`: Parakeet v3 (25 languages), GigaAM v3 and GigaAM v3 CTC
  (Russian), each pinned to one commit and checked by sha256, run with sherpa-onnx — moved from
  max-cli. The models live in one folder for every CLI (`<cache>/cli-messaging/models/audio`,
  moved by `MESSAGING_CACHE_DIR`), so one download serves them all. **Parakeet is first by default**;
  a CLI puts its own first with `Messenger.speechModels` — max-cli would pass `["gigaam-v3"]`.
- **`messages transcribe` chooses between the messenger and this machine.** The profile's
  `transcribeWith` is `auto` (default: the messenger, and the local model when it refuses the
  account), `messenger` or `local`; `speechModel` picks the model. `--local` and `--model <id>` on
  the command, `local` on the tool. The answer says `via` (the provider, or `local`) and `model`.
  Nothing ever downloads a model by itself: a missing one is refused with the command that does.

### Fixed

- **A launchd agent no longer starts at the next login just because `server install` wrote it.** launchd
  loads every agent in `~/Library/LaunchAgents` at login, so the file is written disabled; `server start`
  enables it and `server stop` disables it again.
- **`serve`'s log no longer says "Ctrl-C to stop"** — it says which profile it listens for.


## 0.39.0 — 29.09.2026

### Added

- **`messages forward <chat> <message> --to <chat> [--silent]`** forwards one message, and
  `--allow-send` adds its MCP tool `<cli>_messages_forward`. The send guard checks it as a `forward`
  against the chat it goes to — the recipient list and the hourly limit apply there — and the
  confirmation form shows both chats. The answer is the copy in the target chat. An adapter offers it
  with the optional `forward`. There is no retry handle: after an unknown outcome, look in the target
  chat before forwarding again.

## 0.38.0 — 29.09.2026

### Added

- **`review`**, max-cli's: every message, the owner's too, in each chat that changed since `--since`
  (three days without it), cut at the chat list's newest message so `until` is where the next review
  starts. `--chat` reads one chat, `--unanswered [hours]` keeps the questions nobody answered, `--all`
  takes in muted and archived chats. The `review` tool and the `review` prompt answer the same.
  History pages backwards from the newest message, so a chat cut short keeps its newest 300 and the
  review says it is incomplete. A messenger that knows a group's admins offers the optional `admins`,
  and their answers count too.

## 0.37.0 — 29.09.2026

### Added

- **`messages transcribe <chat> <message>` and the MCP tool `<cli>_messages_transcribe`** turn a
  voice or video note into text with the messenger's own speech recognition, through the new
  optional adapter method `transcribe?()` (`Transcript`). `pending: true` means the messenger was not
  finished; the command says so on stderr.

### Fixed

- **The photo tool's refusal names a command that runs**: `messages download <chat id> <message>`,
  with the chat resolved to its id, not the words the caller typed. Its text part says `chatId`.

## 0.36.0 — 29.09.2026

### Changed — may break callers

- **Every `MessageStore` method returns a `Promise`**, `close` included, so a store that is not
  SQLite can stand behind the same interface later. The work passed to `withStore`, and an MCP
  tool's `stored`, return a `Promise` too. A caller adds `await`; one that keeps a store open around
  its own work writes `return await work(store)` inside `try/finally`, or the store closes before
  the work finishes. A refusal — a search too short, a `find` with neither text nor sender, a
  `message` id two chats share — is now a rejected promise: a `try/catch` without `await` no longer
  catches it.

## 0.35.0 — 29.09.2026

### Added

- **The MCP photo tool, `<cli>_messages_photo`**, answers a message's photo as image content, up to
  512 KB, with the chat, message id and size as text. A larger photo, a file, a video or a voice
  message is refused with the `messages download` command that saves it. A tool answer may now be a
  `Picture` rather than JSON.

## 0.34.0 — 29.09.2026

### Added

- **`inbox` leaves out muted and archived chats** unless they mention the owner or reply to them;
  `--all`, and `all` on the `inbox` tool, take them in. The answer's `quiet` counts the chats left out,
  and a note says so. On the owner's Telegram account 83 of 88 unread chats were muted.
- **`Chat` gains `muted`, `archived` and `unreadMentions`**, each absent where the messenger does not
  say. A messenger fills them in its adapter.

## 0.33.1 — 29.09.2026

### Fixed

- **`service install` writes a `$` in a path as itself in `Environment=`**, where systemd gives it no
  meaning; it was doubled, which changed the path. `ExecStart=` still doubles it. On macOS `install`
  now creates the folder the agent's log goes to, which launchd does not create.
- **`backfill status` and `backfill cancel` confirm that a job's PID is still the job** — its
  environment names the job — before calling it running or signalling it. A PID is handed out again
  after a crash or a reboot; `cancel` could have sent SIGTERM to an unrelated process, and `status`
  reported such a job as running. Unconfirmed, it is `died`. Linux and macOS.

## 0.33.0 — 29.09.2026

### Added

- **`messages edit <chat> <message> [text]`** changes the text of the owner's own message, and
  `--allow-send` adds its MCP tool `<cli>_messages_edit`. Both go through the send guard as an `edit`:
  the profile's `allow`, the recipient list, the hourly limit, and a journal line without the text.
  An adapter offers it with the optional `edit`; without it the command says the messenger cannot edit.
- **`guardedWrite`** (`./sends`): check, act, then record on every outcome — the shape of a write
  that is not a message send.

## 0.32.0 — 29.09.2026

### Added

- **`messages send --silent`, `--no-preview` and `--md`**, and `silent`, `no_preview` and `markdown` on
  the MCP send tool. They reach the adapter as `SendOptions` (`silent`, `noPreview`, `markup`).
  `--md` reads the same inline marks as max-cli's — `**bold**`, `_italic_`, `~~struck~~`, `` `code` `` —
  and `parseMarkdown` is exported, so a messenger formats one message alike. An adapter that cannot
  honour one of these options should refuse the send, not drop the option.

## 0.31.0 — 29.09.2026

### Added

- **`qrPng(link, scale?)`** — the login QR code as a PNG image, beside `terminalQr`, for a CLI to write
  to a file an agent can pass on. 8-bit greyscale, 8 pixels a module by default, written with
  `node:zlib` and no new runtime dependency.
- **`doctor report` and `doctor report create [--run <id>] [--output <file>]`** — a problem report
  as one JSON file: what `doctor` answers, the failed run's requests (the newest, or the one named) and
  the last 20 send attempts. Every chat, message and account id becomes a label salted per report, the
  home folder becomes `~`, and a run event keeps only its named fields — never message text, a title,
  a name, a phone number or the session (copied from max-cli). `AppIdentity.issues`, when set, is where
  the report says to send it.
- **`messages search --regex <pattern>`** — the words are one regular expression, case-insensitive,
  tested against every stored message's text, newest first, until `--limit` match. No index serves it
  and the store is unchanged: it reads the chat (`--chat`) or the whole account a chunk at a time.
  `MessageFilter.pattern` does the same for a caller of the store.
- **`export <chat> --format markdown`** — the chat as a transcript a person reads: a heading per day,
  `hh:mm Name`, replies and forwards quoted, attachments as links, control characters shown rather than
  obeyed (max-cli's `toMarkdown`). A reply Telegram sent only the id of is quoted from the export when
  that message is in it. Any other `--format` is refused; `--json` and `--jsonl` stay the data formats.
- **`backfill <chat> --estimate`** — how many messages, requests, runs at `--max` and seconds a full
  backfill would still take, from the store alone: no request. Message ids leave gaps, so the ids not
  held are priced at the density of the stretches held — an estimate, and FloodWait comes on top. With
  nothing held of the chat, `missing` is `null` and the note says to run a small backfill first.

## 0.30.0 — 29.09.2026

### Added

- **`backfill --background` runs a backfill as a job that outlives the command**, and `backfill list`,
  `backfill status [job]` and `backfill cancel <job>` follow it. A job is a detached process with a
  record and a log under the state folder (`backfill/<job>.json`, `.log`); the record holds its progress
  after every page and how it ended, and `status` adds the stretches the store now holds of the chat.
  One job per chat at a time. The job gets the profile pinned and none of the shell's `<PREFIX>_TIMEOUT`.
- **`serviceCommand(messenger)` — `service install|uninstall|start|stop|status|logs`** runs `serve` as a
  user service: a systemd user unit on Linux, a launchd agent on macOS, one per profile. `install` only
  writes the file — nothing starts or enables it until `service start`, so serve never starts by itself. The unit runs the same
  node binary and script that installed it, with the profile and the location variables
  (`<PREFIX>_CONFIG_DIR`/`_STATE_DIR`/`_CACHE_DIR`, `MESSAGING_STORE`) of that shell, so a unit written
  from a development checkout opens that checkout's files. `status` reads the unit and the serve lock.

- **`messages download <chat> <message> [--output dir]`** saves every file of one message into a
  folder (the current one by default, created if missing) and answers each file's path and size.
  A name another person chose is stripped of folders, a leading dot and control or direction
  characters; a file already there is never overwritten. The adapter supplies the bytes through the
  new optional `download?()` method (`Download`, `RemoteFile`); a messenger without it refuses.

### Fixed

- **`backfill` stops cleanly on Ctrl-C or SIGTERM** — which `backfill cancel` sends — after the page in
  hand, keeps it, and answers `"stopped": true`. It was killed mid-page before.

## 0.29.1 — 29.09.2026

### Fixed

- **`messages list --jsonl` and `messages search --jsonl` print one message per line**, as `inbox`,
  `watch` and their own `--help` promise. They printed the whole page as one JSON line. A script that
  worked around it by reading `.items` from that line must now read each line as a message; the hint
  about older messages goes to stderr.
||||||| parent of d951948 (feat(inbox): leave out muted and archived chats unless they mention the owner)

## 0.29.0 — 29.09.2026

### Fixed

- **Depends on `@leemour/cli-core` 0.8.0** (was 0.7.0), the version max-cli uses. With two versions a CLI
  installed two copies, and `isCliError()` — an `instanceof` check — did not recognise an error made by
  the other copy.

Nothing in the package yet. The repository gained a coverage floor, `pnpm test:slow`,
`pnpm docs:check` and developer docs, and `bin/release` takes the next free version itself.

## 0.28.0 — 29.09.2026

### Added

- **A read across a chosen list of accounts.** `accounts` in a message filter and in `people()`
  names several accounts of one provider by native id — max-cli's `--bots a,b`. A list without its
  provider is refused, so a read is never across every account by accident.

### Changed — may break callers

- **Message search finds any three letters inside a word** (store migration 5 rebuilds the index
  with the trigram tokenizer). Every word of three characters or more must appear; shorter ones are
  ignored, and a query of only short words is refused.

## 0.27.0 — 29.09.2026

### Added

- **A new `MessengerAdapter` method is optional** and reached with `capability()`, which refuses
  with `validation_error` rather than crashing when the adapter lacks it. `observed` and `stored`
  pass through any method they do not list, so an adapter's new method needs no wrapper edit.
  Inside, the shared commands and the MCP tools are one file per resource; the exports and the
  behaviour are unchanged.

## 0.26.0 — 29.09.2026

### Changed — may break callers

- **People are kept per account** (store migration 4, `account_identities`). An identity stays one
  per provider, and which account has seen it is a row of its own, so one bot's people are not
  another's. `savePeople` takes an `AccountKey` instead of a `Provider`, and `people()` reads through
  the account.

## 0.25.0 — 29.09.2026

### Added

- **`inboxCommand`**: other people's unread messages in every chat, or with `--new` what arrived
  since the last check — each message once, the saved point moved only by a run that printed.
  `--since` takes an ISO time or `30m`/`2h`/`1d`. With the MCP tool `<cli>_inbox` and the
  `catch-up` prompt.

## 0.24.0 — 28.09.2026

### Added

- **`skillCommand(app, url)`**: `skill show` prints the CLI's own SKILL.md for an agent.
- **MCP prompts** `reply` and `find`, and the resource `<cli>://chat/{id}` — a chat and its recent
  messages, listed from the store without connecting.

Older versions: `git log --oneline v0.23.0` and the release commits (`chore: release X`).
