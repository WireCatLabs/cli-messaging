# Changelog

Notable changes to `@leemour/cli-messaging`, one section per version, newest first. Versions follow
[semver](https://semver.org/); before `1.0.0` a minor version may break callers, and says how under
"Changed — may break callers". `pnpm docs:check` checks the shape of this file.

## Unreleased

### Added

- **`skill install [--for claude|agents|all]`** beside `skill show`, from cli-core's `skillCommand`:
  it writes SKILL.md, stamped with the CLI's version, to `~/.claude/skills/<appName>/` and
  `~/.agents/skills/<appName>/`. It refuses a SKILL.md whose frontmatter `name` is not the app name.
  `skillCommand(app, skillUrl)` keeps its signature.
- **A daily hint for agents.** `run()` prints one line on stderr when `AI_AGENT` or `CLAUDECODE` is set
  and no copy of the skill is installed, or an older one: `` `<cli> skill install` installs this
  tool's guide``. It shares the update notice's state file, never prints on stdout, after a failure
  or under `--quiet`, and the setting `skillHint: false` in the configuration's `defaults` turns it off.
- **`Messenger.skill`**: the CLI's SKILL.md. When set, the MCP server serves it as the resource
  `<command>://skill` and names it in its instructions.

### Changed — may break callers

- **Depends on `@leemour/cli-core` 0.11.0.** A CLI that uses this package moves to cli-core 0.11.0 in
  the same change, or pins one copy with a pnpm override.

- **`BotMessenger.connect(command, token, { stop, events })`** (P8): the bot client gets the run's
  events, so `bot auth show --trace` prints each request and the run record counts it. The third
  argument was `stop` alone; no CLI implements it yet.


### Fixed

- **`serve` and `watch` stopped by SIGTERM or Ctrl-C finish normally.** Telegram's library closes its
  storage on the signal and then sends it again; with the command's handler already spent, the second
  one ended the process at once — `serve` left its lock (`server status` said `stale`) and printed no
  result. The handler now stays until the run is over.
## 0.93.0 — 01.10.2026

### Added

- **The agent's answers decide conversations** (storage phase 4): `conversations build` reads the user's
  agent's current answer for each message and chooses the messenger's reply first, then the agent's
  answer, then the rules. An answer whose message or parent changed after it was written is left out.
  Rules version 4, so `store check` names the chats to rebuild.
- **`conversations batches status|next --chat <chat> [--size <n>]`** (storage phase 4): a chat in
  windows for the user's own AI agent to link — the messages it is asked about, which have no messenger
  reply and no current answer, and the 50 before them as context, with the rules' candidate links.
  `status` says how many messages, batches and characters are left, to tell the user before starting.
  Message text goes to stdout only, never into a run record. The CLI calls no model.

### Fixed

- **A development checkout's `server start` no longer drives the installed tool's unit.** The unit
  was named by profile alone, so a checkout with its own `*_STATE_DIR` or `MESSAGING_STORE` found
  the real `tg-serve-default.service` and started it. A unit written with location variables now
  carries a short hash of them in its name; one written without (the installed tool) keeps its name.

## 0.92.0 — 01.10.2026

### Added

- **The shared `bot` group** (P8): `botCommand(bot)` builds `bot auth set|show|remove`, `bot list
  [--check]`, `bot chats list`, `bot recipients list|add|remove|clear` and `bot sends list` over a
  `BotMessenger`; a CLI adds the commands that are still its own with `addCommand`. `botContext` hands
  a command the bot's settings, token, seen chats, recipient list and journal. `BotMessenger` gains
  `readSecret`, a seam for the token prompt.

### Changed — may break callers

- **Depends on `@leemour/cli-core` 0.10.0.** A CLI that uses this package moves to cli-core 0.10.0 in
  the same change, or pins one copy with a pnpm override: with two copies, a command marked as
  changing something (`annotate`) loses the mark in the other copy's `describeProgram`, and errors
  from one copy are not instances of the other's classes.
- **`chats folders list` answers `{ items, page, limit, hasMore }`** in `--json`, and so does the tool
  `chats_folders_list`; they printed a bare array.

### Fixed

- **max can upgrade past `--at`.** The parity manifest required max to still have `messages send --at`,
  so max's own parity check failed on any release with `--at-time`; both rows are planned until max's
  main moves.

## 0.91.0 — 01.10.2026

## 0.90.0 — 01.10.2026

### Added

- **`serverCommand(messenger, options)`** — a CLI whose server is not tg's lock file says how it is
  found, started and stopped (`options.process`: `probe`, `launch`, `stop`), where it logs, what a
  unit runs (`serveArgv`), `--idle` on `start`/`restart` (`idle: true`), and the unit's purpose and
  the exit codes that must not restart it (`unit.noRestartOn`: systemd's `RestartPreventExitStatus`;
  launchd then does not restart at all). `start` takes the place of a server a command started.

### Changed — may break callers

- **`server` says "connected", not "listening"**, in its lines and errors; `server start` also
  answers `startedAt` and `log`; `server stop` answers `by` as `status` does.

## 0.89.0 — 01.10.2026

### Added

- **A chat the account has left leaves the store's lists, and `store clear --left` deletes it.** A
  chat list that names every chat (offset 0, nothing more) marks the chats it leaves out with
  `membershipState: "left"`; `chats`, `countChats` and `chatsWith` skip them, their messages stay,
  and a chat the list names again is unmarked. `markChatsLeft` and `leftChats` on the store,
  `archive.left` on the services. `store clear --left --allow-dangerous` deletes this account's left
  chats with their messages, members and leases; without `--allow-dangerous` it says how much it
  would delete. No schema change: version 6's `membership_state` already holds `left`.
- **`cli-messaging-parity wording <max.json> <tg.json>`** and `wordingProblems` in `./parity`: every
  `both` option the two tools describe in different words, unless its catalogue entry has a `note`.
  The parity workflow runs it on both CLIs' `main`.
- **The store reads and writes conversations**: `linkInputs` pages a chat's messages oldest first for
  the rules, `replaceConversations` writes a chat's new build of links and conversations in short
  transactions and makes it current in one (the agent's links stay, marked stale when their message
  changed after them), and `conversations`, `conversation`, `conversationOf`, `links` and
  `conversationState` read them back.
- **`conversations build --chat <chat>`**, **`conversations list --chat <chat> [--since-time]`** and
  **`conversations show <id>`** (or `show <chat> <message>`): the conversations inside a group chat,
  found in the stored messages by replies, mentions and who wrote next; nothing is built until asked.
  **`messages links <chat> <message>`** says why a message is where it is. MCP: `conversations_list`,
  `conversations_show`. The commands are shared; tg and max get them when they mount
  `conversationsCommand`. A profile that denies `messages` is refused them too.
- **`store check` reports conversations**: per built chat, the rules version that built it, whether it
  is this build's, and how many of the agent's links went stale; a note names the chats to rebuild.
- **`Message.mentions`**: the people a message mentions by id, where the messenger marks them; the store
  keeps it and the mention rule follows it, so a mention by name with no `@handle` links too (rules v3).

### Changed — may break callers

- **`chat_messages_edit` takes `md`**, as `chat_messages_send` does; the option is `--md`.

## 0.88.0 — 01.10.2026

### Added

- **`chats rules show|set|unset` and `chats moderate`**, with the tools `chats_rules_show` and
  `chats_moderate` (P2, `chats check` in max-cli). A group's rules live in
  `<state>/profiles/<profile>.moderation.json` — max-cli's file, so its rules carry over, its
  `forbid`/`flag`/`confirm` read as `deny`/`ask`/`ask`, the profile's own levels. Each kind of action has a level:
  `deny` never acts, `readonly` reports, `ask` asks at the terminal (`--allow-dangerous` says yes;
  over MCP it is planned), `allow` acts. Its deletions and removals go through the guard as
  `chats.moderate`, so `messages.delete` does not ask again. Where the next run starts is kept in the
  same file. `GroupMember.registeredAt`; `Messenger.knowsAccountAge: false` refuses the `newAccount`
  rule. `judge`, `act` and `Moderator` are exported for a bot.
- The manifest says the contact writes and `account update|sessions end` are in both tools.
- **`@leemour/cli-messaging/background`** (P6): the lock per app and profile, `alive`/`carries`/
  `holdersOf`, the `ServerSystem` seam, and systemd and launchd units, moved out of the `serve` and
  `server` commands so max's server can use them too. The commands behave as before; `./cli` still
  exports `servingProfiles` and `ServerSystem`.
- **A test can hand in the local speech recognizer**: `recognizer` in the environment `run()` and
  `provide` take, used by `messages list --transcribe` and `messages transcribe` in place of the
  downloaded model.
- **Conversation tables in the store (store version 13)**: `message_links`, `conversations`,
  `conversation_messages` and `conversation_state`, empty until phase 3's `conversations build` fills
  them. Every foreign key cascades, so deleting messages or chats — by any build — takes their
  conversation rows with them. Each rebuild of a chat is written under its own build number and made
  current at once, so a big chat's rebuild never holds the write lock for long. `messages.mentions`
  keeps whom a message mentions by id, where the messenger says so.
- **A bot's pieces, for the shared bot commands** (P8): `BotTokenStore` (keyring account
  `bot:<profile>` under the app's own service, `<PREFIX>_BOT_TOKEN` first, then a 0600 file),
  `ChatRegistry` and `registryProfiles` (the chats a bot has seen, one 0600 file per bot),
  `botFiles` and `botsDirectory` (max-cli's paths, unchanged), and the types `BotMessenger` and
  `BotAdapter`. From `@leemour/cli-messaging/cli`.

- **A bot's settings** (P8): the file gains `personal` and `bot` sections, each with `defaults` and
  `profiles`; the most specific entry wins — this profile's bot entry, the profile, every bot,
  everyone. `resolveSettings(flags, { kind: "bot" })` reads them; `Settings` gains `kind` and
  `readOtherBots` (a bot setting: which other bots' local copy it may read). A bot has no hourly
  limit unless its section sets `sendsPerHour`. `config show --bot`, and `config set|unset --bot`
  or `--personal`, write into a section.
- **Bot permission keys**: `bot` is a resource, and every bot command is keyed under it —
  `bot.messages.send`, `bot.chats.members.remove`; `bot auth|list|recipients|sends|mcp` are never
  gated. `bot.messages.delete` asks by default. A bot's old `readOnly` and `allow` become `bot.*`
  levels (`fromOldSettings(…, { bot: true })`) and leave the personal account's alone.
- **`messages list --before-time`**, reading back from a moment, and the optional adapter method
  `historyBefore` in `ChatReading` behind it. A messenger without it is refused, saying so.

### Changed — may break callers

- **MCP arguments carry their option's name** (STANDARD, MCP rule 2), and agents must use the new
  ones: `chat_messages_list` takes `before_id`, `before_time`, `after_id`, `after_time` — at most one —
  instead of `before`, `after`; `chat_messages_context` takes `before_n`, `after_n`; `since` is
  `since_time` in `chat_inbox`, `chat_review`, `chat_chats_events`, whose `event` is `type`;
  `chat_messages_send` takes `md` and `at_time`. `chat_messages_list`, `chat_messages_context` and
  `chat_chats_events` answer `{ items, page, limit, hasMore }`, as their commands do. `afterOf` and
  `oneDirection` are gone; `listStart` takes the four starting points and how to spell them.
- **`messages send --at` → `--at-time`**: every option that takes a time names it. No alias; the MCP
  argument is `at_time` too.
- **`server status` answers the shape both tools share** (STANDARD, Output rule 6):
  `since` → `startedAt`, `listening` → `connected`, `listeningSince` → `connectedAt`; new `cliVersion`,
  `log`, and `stale` for a lock a serve that is gone left behind. `server start` answers `startedAt`
  and `connectedAt` the same way.

## 0.87.0 — 01.10.2026

### Added

- **`account update`** — `--first-name`, `--last-name`, `--description`, `--photo <file>` — and
  **`account sessions end --others`**, with the tool `account_update` (P2). The answer masks the
  phone as `account show` does. Ending other sessions logs the owner out of the phone too: it asks
  first by default (`account.sessions.end: ask`; `--yes` answers), and it has no MCP tool at any
  level. A new port group, `AccountEditing` (`updateProfile`, `endOtherSessions`), `ProfileChange`,
  and `Services.account`.

- **`contacts add|remove|block|unblock <person>`, `contacts rename <person> <first-name> [last-name]`
  and `contacts import <file>`**, with the tools `contacts_add|remove|block|unblock|rename` (P2).
  Each goes through the guard as an `account` write. `import` reads a file — one `number, name` per
  line, comma, tab or semicolon between — so no number is on the command line; a bad line is named
  by its number only, and the answer and the journal hold counts, never a number. It has no MCP
  tool. A new port group, `ContactBook`; `PhoneBookEntry` in the domain; `PeopleService` gains the
  writes.
- The manifest says `chats folders list|create|update|delete` are in both tools.
- **A duration takes `h` and `d` too** — `--timeout 1h`, `--pause`, and every option that reads one
  with `parseDuration`.
- **`listed` and `renderList`** in `./cli`: a list with no pages in the envelope a paged one uses —
  `page: 1`, `limit` the count, `hasMore: false`.

### Changed — may break callers

- **Options name the kind of value they take** (STANDARD rule 5; no aliases, the old names are
  unknown options now):
  - `messages list --before` → `--before-id`; `--after` → `--after-id` or `--after-time`, so a
    message id that looks like a time is never read as one;
  - `messages context --before`/`--after` → `--before-n`/`--after-n`;
  - `--since` → `--since-time` in `chats events`, `inbox`, `review`, `store export`, `store fetch`;
  - `store fetch --max-pages` → `--limit <n>`, messages in one run, and `--page-size <n>`, messages
    per request; the run stops at exactly `--limit`. A job records `limit` and `pageSize`.
    `FetchOptions` and `archive.estimate` take `limit` and `pageSize` instead of `maxPages`;
    `Fetching.maxPages` stays, as the messenger's default;
  - `messages download --output` → `--output-dir`; `chats events --event` → `--type`.
- **`review --unanswered` takes a duration** — `4h`, `1d` — not bare hours; `24h` without a value,
  as before. `--unanswered 4` is now refused, with the units it takes. The MCP tool's `unanswered` stays
  a number of hours.
- **Every list answers `{ items, page, limit, hasMore }` in `--json`.** `store status` and
  `store jobs list` printed a bare array; `messages scheduled`, `messages context`,
  `account sessions list` and `models audio list` printed only `items` (`directory` stays beside
  them); `messages list` gains `page: 1`. `chats events` moves `events` to `items` and `more` to
  `hasMore`, keeping `chatId` and `since`; `server logs` moves `lines` to `items`, keeping `profile`
  and `unit`. `--jsonl` and the tables a person sees do not change.
- **`messages send` and `messages edit` drop `--markdown`; `--md` stays.** The standard allows no
  alias. A script that types `--markdown` now fails with an unknown option.
- **`messages send --file`, `--photo`, `--voice` show their value as `<file>`**, the argument name
  the standard fixes. Only the help text changes.

### Fixed

- **A person or a stored chat named by an id that is not digits is found by that id.** `pickPerson`
  looks the reference up as an id before matching names, and `--offline` reads match a stored chat's
  exact id before titles. Telegram and MAX ids are digits and behave as before.
- **`messages download --all` walks each page in the order the messenger returned it**, newest first,
  instead of sorting the page by id as a number. Ids that are not safe integers are still refused,
  since the progress file compares them. Telegram's history comes oldest first, so its order is unchanged.

## 0.85.0 — 01.10.2026

### Added

- **`Messenger.fetching`: how `store fetch` reads a messenger's history** — messages per request,
  the least pause between requests (with `jitter`, each up to twice that), pages per run, and
  `orderBy: "time"` for a messenger whose ids pass 2^53 and do not count messages: its held stretches
  are kept by send time and `before` reaches the adapter as an ISO time; `--estimate` refuses there.
  `--max-pages` and `--pause` default to the messenger's. Without it, nothing changes. `history`
  takes `reactions: false`, which `store fetch` passes: a page it stores needs none.
- **`store export --format jsonl`**, the default said out loud: one message per line, on stdout or
  in `--output`.

- **`cli-messaging-parity <cli> --pages <file...>`** checks user pages against the command tree on
  stdin: every `<cli> <command> --option` a page names must exist on that command, or be in the
  manifest for it and not only for the other tool. `pageProblems` in `./parity` is the same check.

### Changed — may break callers

- **A message id is opaque, not digits.** An MCP tool's `message` or `before` takes any id up to 256
  characters with no space or control character, and `--after` / `after` reads a time only
  when it looks like one — an ISO 8601 date or time, or `30m`, `2h`, `1d`. Anything else now reaches
  the messenger as a message id instead of being refused by the argument check, so the adapter must
  check an id's shape itself. Ids with a space are still refused up front.

- **`new RecipientList(path, command)` requires its second argument**, the app's `command`; the hints
  in a refusal no longer default to `tg`. `sendGuard` without `command` now takes the recipient
  list's.

### Fixed

- **`watch` keeps the last messages before it exits.** Closing waits up to 5 seconds for the saves
  still being written; one that takes longer is a warning, and the command still ends normally.

## 0.84.0 — 01.10.2026

### Added

- **`chats folders list|create|update|delete`**, and the tools `chats_folders_list|create|update|delete`
  (P2). A folder is named by its id or its title exactly; two with the same title are refused. Each
  change goes through the guard as an `account` write (`folder-create`, `-update`, `-delete`). A new
  port group, `ChatFolders`; `Folder` and `FolderChange` in the domain; `Services.folders`.
- The manifest says `chats members add|remove` and `chats admins add|remove` are in both tools.

### Fixed

- **On a SQLite without full-text search, the store refuses with a message that says what to do**,
  before it writes anything: official Node 22.0–22.15 and 23.x ship one, and so may Bun on an old
  macOS. Before, the store failed on such a Node with `no such module: fts5` and could not be used at
  all. `engines.node` is now `^22.16.0 || >=24`, the Node versions the store works on.

- **A message deleted with `messages delete` is gone from the store too**, so `messages search` and
  `messages list --offline` stop showing it; an edit replaces the stored text, and a forwarded copy is
  kept in the chat it went to. Before, the store kept what the read before the write had saved.

## 0.83.0 — 01.10.2026

### Added

- **`chats members add <chat> <person...>`** (`--history` where the messenger has it),
  **`chats members remove`**, **`chats admins add <chat> <person> --can <rights>`** and
  **`chats admins remove`**, with the tools `chats_members_add|remove`, `chats_admins_add|remove`
  (P2). The people are resolved to ids first; adding counts each person toward the hourly limit and
  refuses one the recipient list does not name. `members add` answers `added` and `notAdded`.
  `GroupAdmin` gains `addMembers`, `removeMembers`, `addAdmin`, `removeAdmin`; `ADMIN_RIGHTS` and
  `AdminRight` in the domain; `Messenger.addsWithHistory` and `Messenger.adminRights` say what a
  messenger offers.
- The manifest says `chats update` (title, description, `--all-can-pin`, `--only-admins-add`) and
  `chats link show|reset` are in both tools.

- **Store version 12: a word index over the normalized text**, for the ranked search that comes
  next. A file of up to 5,000 messages is indexed when it is opened; a larger one is indexed later
  in batches. Older builds keep opening the file (`min_compatible` stays 6), and what they write is
  indexed. Saving messages is about a quarter slower and the file about 15% larger (measured, 100,000
  messages through the store).

## 0.82.0 — 01.10.2026

### Added

- **`chats update <chat>`** — `--title`, `--description` and the group's settings as `--<setting> on|off`,
  one write — **`chats link show|reset`**, and the tools `chats_update`, `chats_link_show`,
  `chats_link_reset` (P2). `chats show` adds a group's `description`, `link` and `settings` where
  the messenger reads them. `GroupAdmin` gains `group`, `updateGroup` and `resetInviteLink`;
  `Messenger.groupSettings` names the settings a messenger has, and `chats update` offers only those.
  `GroupChange` and `GROUP_SETTINGS` in the domain.
- The manifest says `chats create`, `join` and `leave` are in both tools.

## 0.81.0 — 01.10.2026

### Added

- **`chats create <title> [person...]`, `chats join <link>`, `chats leave <chat>`**, and the tools
  `chats_create`, `chats_join`, `chats_leave` (parity plan P2). Each goes through the guard as a
  `chat` write and answers `{ operationId, chat }` (`leave`: `{ operationId, chatId }`); the people
  added are resolved to ids first, so the recipient list and the hourly limit count them. A new port
  group, `GroupAdmin` (`people`, `createGroup`, `join`, `leave`), and `GroupCard` / `GroupSettings`
  in the domain; `Services.admin`. A messenger without the group refuses with "this messenger
  cannot …".
  conversation rows with them.
  Each rebuild of a chat is written under its own build number and made current at once, so a big
  chat's rebuild never holds the write lock for long.
  `messages.mentions` keeps whom a message mentions by id, where the messenger says so.

## 0.80.0 — 01.10.2026

## 0.79.0 — 01.10.2026

### Fixed

- **`chats show`, `contacts list` and `contacts show` no longer fail online when the store does not
  know the profile's account yet** — before the first connection that names it. They answer with
  what the messenger gave, as they did before they read the store.
- **`contacts list` asks for the chats before it reads the store**, so on a messenger whose login
  brings the people the first run lists them rather than the dialogs.

## 0.78.0 — 01.10.2026

### Added

- **`messages list --mark-read`** marks the chat read up to the newest message shown — the other
  person sees it — and answers `markedRead: { operationId, until }`; refused with `--offline`.
  Nothing else in `messages list` marks anything read. The `messages_list` tool stays read-only:
  `chats_mark_read` does that behind its own permission.
- **`--model <id>` beside `--transcribe`** on `messages list` and `inbox`, and `model` on their tools:
  which downloaded speech model hears the voice messages. Alone it is refused rather than ignored.
- **`review --transcribe`** and `--model`, and `transcribe` and `model` on the `review` tool: voice
  messages in a review come with their text, and `unheard` lists the rest.
- **`messages send --voice <file>`**: an Ogg Opus file (`.ogg`, `.oga`, `.opus`) as a voice message,
  alone — no text, no file, no photo beside it. **`--as-file`** sends the `--file` as a file to
  download even where the messenger would play it, a video included. The `messages_send` tool takes
  `voice` and `as_file`. `UploadKind` gains `voice`, `Upload` gains `asFile`, and `readAttachments`
  reads what a send attaches, the same for the command and the tool.

## 0.77.0 — 01.10.2026

### Changed — may break callers

- **MCP offers tools by the profile's permissions, not by flags.** With the defaults, every write
  tool is offered and acts without a form; `messages_delete` (level `ask`) shows the owner a form
  first, which `mcp --allow-dangerous` skips, as the global `--yes` does for any other write at
  `ask`. `deny` hides a tool, `readonly` hides the writing ones, and with `messages: deny` the
  prompts and resources are not offered either. `--confirm-send` still puts every write through
  the form. `--allow-send`, `--allow-mark-read` and `--allow-delete` decide nothing: they are
  accepted with a warning so a configured agent still starts. `createServer` takes `confirmSend`,
  `yes` and `allowDangerous`; `instructions` takes the offered `writes`; `<cli>_status` answers
  `permissions` instead of `allow`.

### Fixed

- **A `--limit` or `--page` that is not a whole number is refused as typed**: `--limit abc` said
  `not NaN`, and `--limit 12abc` was quietly read as 12. Both are now `validation_error` quoting the
  value. `positiveCount(flag)` in `cli/paging.ts` is the one parser for them.
- **The transcript speaks the app's language.** `AppIdentity.locale` (for example `en-GB`) sets the
  day headings and the word for your own messages in every command that prints a conversation;
  tg printed `вы` and `3 января 2026`. Unset, it stays `ru-RU`, so max-cli does not change.

- **Saving messages compiled every SQL statement again on every call.** The store now queries through
  Drizzle, one module per kind of record under `src/store/sqlite/`, and prepares the statements each
  saved message runs once per open store: 9,131 rows/s at a million messages instead of 6,900, with a
  sixth less peak memory. Search answers as before. `MessageStore` does not change.

## 0.76.0 — 01.10.2026

### Added

- **`deny` stops reading too.** A command whose key is `deny` is refused (`permission_error`) before
  it connects or opens the store — `messages list`, and everything else that shows messages:
  `inbox`, `review`, `watch`, `serve`, `store fetch|export|search|status|jobs`. Housekeeping
  (`config`, `doctor`, `runs`, `store info|check|migrate|backup|restore`, …) is never stopped.
  `keyForCommand(path)` says which key a command path is checked against.
- **Permissions: one level per command path.** A profile's `permissions` setting maps command paths
  to `deny`, `readonly`, `ask` or `allow` — `config set permissions.messages.delete allow` — and the
  most specific key the owner set wins. A key starts with a resource (`messages`, `reactions`,
  `polls`, `topics`, `chats`, `contacts`, `account`), so a misspelled one is refused. By default
  everything is allowed except `messages.delete` and `account.sessions.end`, which ask; a built-in
  default only ever tightens a broader key. `ask` asks y/N at the terminal, never under `--json` or
  `--jsonl`; `--allow-dangerous` (deleting) or the new global `--yes` (every other write) answers
  yes, and with nobody at a terminal the write is refused (`confirmation_required`). `readOnly` and
  `allow` keep working, read as levels. Exports `LEVELS`, `levelFor`, `DEFAULT_PERMISSIONS`,
  `fromOldSettings`, `keyForWrite`; `sendGuard` takes `permissions` and `ask`, and without them
  decides as before; `SendGuard.ask` is the question `guardedWrite` awaits before `check`, and
  `check` refuses an `ask` write that was never asked. MCP is unchanged for now.

- **`polls create --revote`**, and `revote` on the `polls_create` tool: people may change their vote.
  Without it they cannot, in every messenger — MAX's default, and now Telegram's too: a tg poll made
  without `--revote` stops allowing a changed vote. `NewPoll.revote`; an adapter treats it absent as
  `false`.
- **`store fetch --last <n>`**: stop once the newest n messages of the chat are held, counted in the
  store, so a later run with the same `--last` asks for nothing. Not with `--since`. `FetchOptions.last`;
  the answer carries `reachedLast: true` when it stopped there.
- **`chats show` and `contacts show` answer with `--offline`**, from the store. `chats show` fills
  `members` from the member list the store holds, online too when the messenger gave none; with no
  list saved it stays `null`. `contacts show` fills the shared chats the same way.
- **`contacts list` reads the store's contacts where it holds who is in each one-to-one chat** —
  ordered by the newest conversation, or by name — and from the dialogs as before where it does not.

### Changed — may break callers

- **`messages delete` asks instead of refusing** when `--allow-dangerous` is missing and someone is
  at a terminal; with nobody there it is refused as before.

- **`store fetch --max <n>` is gone; `--max-pages <n>` caps a run instead**, in pages of 100 (10 by
  default, so 1000 messages, as `--max` was). The same names as max-cli's, so one limit has one name
  in both. No alias.
  `FetchOptions.max` and the `estimate` option `max` become `maxPages`; `estimate`'s `runs` counts
  requests per run, a held stretch to step over included. A background job records `maxPages` and
  `last` instead of `max`, and `store jobs` prints them; a job started before shows neither.

## 0.75.0 — 01.10.2026

### Changed — may break callers

- **`runs list`, `sends list` and `recipients list` answer the list envelope** in `--json`,
  `{ items, page, limit, hasMore }`, as every other list does; they printed a bare array. A script
  that read `.[]` reads `.items[]`. `--jsonl` is unchanged: one item per line. `sends list` and
  `runs list` say `hasMore: true` when `--limit` cut the list short.

## 0.74.0 — 01.10.2026

### Added

- **`account show --show-phone`.** `Account` gains `phone`, filled where the messenger tells it;
  `account show` prints its last four digits (`***1234`) unless `--show-phone` is given, and the
  `account_show` tool always does. `maskedAccount` is exported from `./cli`.
- **`store export --output <file> --since <time>`.** `--output` writes JSON lines, or the transcript
  with `--format markdown`, to a new file with mode 600 and answers `{ path, format, count }`; it
  refuses a file that exists. `--since` exports from an ISO 8601 time or `30m`/`2h`/`1d` ago on.
  `ArchiveService.export` takes `{ since }`.

## 0.73.0 — 01.10.2026

### Added

- **`messages edit --md`**, and `markdown` on the `messages_edit` tool: the new text's marks become
  formatting, as in `messages send --md`. `MessageEditing.edit` receives `{ markup }` as a fourth
  argument; an adapter that cannot format refuses it rather than dropping it.
- **`messages forward --send-id <id>`**, and `send_id` on the `messages_forward` tool: a forward whose
  outcome was unknown is repeated with its send id, and the messenger keeps one copy. The answer now
  carries `sendId`. `MessageEditing.forward` receives `sendId` in its options; an adapter passes it as
  the messenger's own deduplication id (Telegram's `random_id`, MAX's `cid`).

## 0.72.0 — 01.10.2026

### Added

- **`guardedVote`, `guardedClose`, `guardedCreatePoll`** from `./cli`: the guarded poll writes, for max-cli's MCP tools while they answer through the shared code.

## 0.71.0 — 01.10.2026

### Added

- **`sendCommand`**, `messages send` on its own from `./cli`, for max-cli's group 4 move.

## 0.70.0 — 30.09.2026

### Changed — may break callers

- **Depends on `@leemour/cli-core` 0.9.0.** A CLI that uses this package moves to cli-core 0.9.0 in the
  same change: two copies of cli-core in one install lose the error codes, because an error from one
  copy is not an instance of the other's classes.

## 0.69.0 — 30.09.2026

## 0.68.0 — 30.09.2026

### Added

- **Each write command on its own**, from `./cli`: `deleteCommand`, `editCommand`, `forwardCommand`,
  `pinCommand`, `unpinCommand` and `markReadCommand`, for a CLI that moves its commands onto the
  shared ones one at a time — max-cli, group by group.

- **`parity.json`, the parity manifest of tg and max**, in the package: every command and option of
  both CLIs, each `both`, one-sided with a reason, or `planned` with who closes it, and the option
  catalogue — one name, one meaning. A CLI checks itself against it with
  `<tool> commands --json | cli-messaging-parity <max|tg>`, which exits 1 and names each difference;
  `@leemour/cli-messaging/parity` exports the same check.

## 0.67.0 — 30.09.2026

### Added

- **`store backup <file>` and `store restore <file>`.** `store backup` copies `messages.db` into a new
  file while it is in use, readable by the owner alone, and never overwrites a file. `store restore`
  puts a backup in place of the store and keeps the store it replaces beside it, as
  `messages.db.before-restore-<time>`; nothing is deleted. It refuses a backup that is damaged or that
  a newer version wrote, a store that another process has open or is writing to, and a store this
  CLI's `serve` is keeping; it ends by saying to restart any running `serve` and `mcp`. `store check`
  now suggests a backup before `store migrate`.

## 0.66.0 — 30.09.2026

### Added

- **`guard` on `Messenger`, optional**: the send guard a command writes through, when the messenger's
  is not the profile's plain one. max-cli's background server journals every write it forwards, so a
  command going through it must record only its own refusals, or each write counts twice.

## 0.65.0 — 30.09.2026

### Added

- **`events` in `ConnectOptions`**: `Messenger.connect` gets the run's diagnostics, from commands and
  from MCP alike, so a messenger can report its own wire — max-cli's frames, with opcode and size —
  beside the adapter's calls.

## 0.64.0 — 30.09.2026

### Added

- **`newSendId()` on the adapter port, optional**: a send id in the messenger's own form. `messages
  send` and `polls create` ask the connection for one before falling back to `newSendId`. MAX's
  official client sends a millisecond timestamp, and max-cli must look like it.

## 0.63.0 — 30.09.2026

### Added

- **`store info`, `store check` and `store migrate`: looking after `messages.db`.** `store info` says
  where the file is, its size, its schema and how many rows it holds. `store check` reports whether it
  is healthy — SQLite's integrity check, foreign keys, the three search indexes against their tables,
  free disk against the file's size, messages waiting for normalization — and names every chat whose
  held history stops before the chat's newest message, with when the chat was last refreshed. It
  repairs nothing. Neither of the two migrates the file. `store migrate` brings the file up to this
  build's schema, then normalizes the messages stored before version 6, in batches, with the progress
  on stderr; stopping it loses nothing. `pendingNormalization` and `backfillNormalized` are exported
  from `./store`.

## 0.62.0 — 30.09.2026

### Added

- **Diagnostic events for a frame protocol.** A request or response event may carry `opcode`, `seq`,
  `status` and `bytes`; a new `cache` event says a read was answered locally, and why; a warning may
  carry `detail`. `renderEvent` shows them. max-cli writes its run records in this one format.
- **`startRecording`**: `recorded` in two halves, for a caller that starts a run before its command
  and ends it after. Exported from `./cli` with `Recording`, `wasSettled` and `runtime`.
- **`allowFix` on the send guard**: the command that changes `allow`, for a CLI whose configuration
  has more places than profiles and defaults.

## 0.61.0 — 30.09.2026

### Added

- **An `operationId` on every write.** Each write the send guard sees — send, edit, forward, delete,
  pin, unpin, react, mark read, poll vote, close and create — has an id. It is in the write's answer,
  on each of its lines in the send journal, and in the `--trace` and run events of the calls it makes,
  so one write can be followed through all three. A send's `operationId` is its `sendId`.
  `newOperationId` and `currentOperation` are exported from `./sends`.
- **The send journal takes max-cli's entries.** Attachments may be `video` and `voice`; account
  actions may be `contact-rename`, `contact-block` and `contact-unblock`, under the `contacts`
  permission.

### Changed — may break callers

- **Every write's `--json` answer and MCP result gains `operationId`.** `messages edit` and
  `messages forward` services return `{ operationId, message }` instead of a bare `Message`; the
  commands already printed `{ message }`. `polls vote` and `polls close` print `{ operationId, poll }`
  instead of a bare poll. `guardedWrite` requires an `operationId` in its attempt.

## 0.60.0 — 30.09.2026

### Removed

- **`drizzle-orm` is no longer installed with this package.** The store's Drizzle modules are bundled
  into `dist/` at build time: loaded from `node_modules`, Drizzle cost Node about 200 ms per process;
  bundled, opening it takes about 6 ms. About 16 MB less for tg-cli and max-cli to install.

## 0.59.0 — 30.09.2026

### Added

- **The adapter port in named groups** — step 3 of the layer design. `MessengerAdapter` is now
  `MessengerCore` (the required methods) plus optional groups: `ChatReading`, `MessageEditing`,
  `MessagePins`, `MessageReactions`, `ReadState`, `MessagePolls`, `LiveUpdates`, `MessageMedia`,
  `ScheduledMessages`, `GroupModeration`, `AccountTools`, all exported from `./cli`. The type is the
  same as before, so no adapter changes; one that has a group can say `implements MessageEditing` and
  be held to the whole group.

## 0.58.0 — 30.09.2026

### Added

- **`@leemour/cli-messaging/services`, and a CLI's own version of a use case** — the last step of
  `docs/plans/2026-09-30-services.md`. The new entry exports the services (`messages`, `chats`,
  `people`, `inbox`, `archive`), their factories, `ServiceDeps`, `onlineDeps`, `storedDeps` and
  `Override`. `Messenger.services` takes an `Override`: it returns the services it changes and can
  call the shared method inside, and commands and MCP tools both get the replacement. MCP tools now
  build their services through `servicesFor`, so the override reaches them. Nothing changes for a
  CLI that sets no override.
- **Services: inbox and archive**, the fourth step of `docs/plans/2026-09-30-services.md`.
  `services.inbox` (`read`, `review`) and `services.archive` (`status`, `held`, `export`, `estimate`,
  `fetch`) take over `inbox`, `review`, `store status|export|fetch` and the MCP `inbox` and `review`
  tools. The `--offline` refusals of `inbox` and `review` moved into the service with the same words.
  Nothing a person or a script sees changes.

## 0.57.0 — 30.09.2026

### Changed — may break callers

Commands follow one naming standard: a noun, then a verb. The old names are gone, with no aliases —
they now fail as unknown commands or options.

- **`export <chat>` is `store export <chat>`**, **`sync status [chat]` is `store status [chat]`**,
  **`backfill <chat>` is `store fetch <chat>`**, and **`backfill list|status|cancel` is
  `store jobs list|show|cancel`**. `store fetch` still fetches by default; `--estimate` only estimates.
  Its `--pace` is **`--pause <duration>`**, and so is `messages download --all --pace`. `--max` keeps
  its name: it counts messages, not pages. A CLI now adds one `storeCommand(messenger)` in place of
  `exportCommand`, `syncCommand` and `backfillCommand`. Jobs started by an earlier version are still
  listed.
- **`messages reply` is gone**: `messages send <chat> [text] --reply-to <message>` answers a message,
  with every send option. The locator form (`messages reply msg:… <text>`) has no replacement;
  `--reply-to` takes the message id in the chat named. The MCP send tool already took `reply_to`.
- **`chats read` is `chats mark-read`**, and its MCP tool `<cli>_chats_read` is
  `<cli>_chats_mark_read`.
- **`messages search <words...>` names its argument `<text...>`**; the search is unchanged.
- **`recipients off` is `recipients clear`**: it deletes the list. The answer is unchanged,
  `{ off: true, wasOn }`.
- **A heard voice message is kept in the shared store, not in `transcripts-<profile>.db`.** The
  transcript belongs to the account the profile last logged in as; a profile never online keeps none.
  `Kept` answers promises now (`get`, `keep`, `close`). Transcripts kept in the old per-profile files
  are not read: each voice message is heard once more, and the old files can be deleted.
- **A deleted message leaves no text behind.** `markDeleted` keeps the tombstone and now empties the
  text, drops the search copy, the edit history and the transcript — in tg-cli and max-cli alike.
  `saveMessages` leaves a deleted message as it is, unless `seenAt` says the messenger returned it
  after the deletion: then it comes back with its text. A caller that read a deleted message's text
  from the store gets `""`.

### Added

- **`Message.senderUsername`** — the sender's handle without `@`, where the messenger has one. The
  store saves it on the sender's identity, and a later message without it keeps the one saved, so
  `people` answers it and a mention can be matched to its sender. An adapter that leaves it out
  changes nothing.
- **Services: chats and people** — the third step of `docs/plans/2026-09-30-services.md`.
  `services.chats` (`list`, `show`, `members`, `events`, `inspect`, `markRead` through the guard) and
  `services.people` (`list`, `show`, `lookup`, `sync`) take over `chats list|show|members list|events|inspect|mark-read`,
  `contacts list|show|lookup|sync` and their MCP tools. `CHAT_SCAN`, `EVENTS_DAYS` and `phoneOf` now come
  from `src/services/`. Nothing a person or a script sees changes.
- **Contacts in the store** (store version 10): `contacts(key, { order: "recent" | "name", query?,
  limit, offset? })` lists the people in the account's one-to-one chats — as far as the saved member
  lists go — with `countContacts` for the same filter; `refreshRecency(key)` works out again when each
  was last written to. A person now keeps `description` (`PersonFacts.description`). Additive: a
  build on version 6 keeps working on the file.
- **Transcripts in the store** (store version 11): `transcript(key, chatId, messageId)` and
  `keepTranscript(...)`, per account, keyed by chat and message id — a message can be heard before
  the store holds it. Additive: a build on version 6 keeps working on the file.
- **Store reads for the services** (no schema change): `chats` takes `query` (three letters or more
  of a title), `kind` and `unread`, with `countChats` for the same filter; `messages` takes `since`,
  with `countMessages`; `messagesWindow(key, chatId, { at, before, after })` reads around a moment,
  as `around` reads around a message id. Type `StoredChatFilter`.
- **`purge(key)`** removes everything one account holds — chats, messages, members, sync state,
  leases, transcripts, whom it has seen — for `cache clear`; other accounts stay whole.
- **`applyDelta(key, { chats?, people?, members?, state? })`** writes a catch-up's whole answer in one
  transaction — chats, people, each listed chat's members, sync state such as a delta marker — so a
  failure leaves nothing half-written. Type `Delta`.
- **`store fetch <chat> --since <time>`** stops after the page that reaches a message older than the
  time: ISO 8601, or `2h` / `1d` ago. The answer then carries `reachedSince: true`. A background job
  gets the time as ISO, so it does not move when the job starts later. Refused beside `--estimate`,
  which prices a full fetch.

## 0.56.0 — 30.09.2026

### Added

- **Sync state in the store** (store version 8): `syncState(key, name)` answers what a sync remembered
  for the account — a delta marker, when a list was last complete — with when it was set;
  `setSyncState` and `clearSyncState` change it. Values are text; a caller encodes a number itself.
  Additive: a build on version 6 keeps working on the file.
- **Fetch leases in the store** (store version 9): `claim(key, chatId, anchor, holder, forMs)` takes a
  stretch of a chat for a while and answers whether this holder has it — refused while another
  holder's lease runs, renewed for the same holder — and `release` gives it back. Two processes
  backfilling one chat no longer fetch the same pages. Additive: a build on version 6 keeps working.

## 0.55.0 — 30.09.2026

### Added

- **Services: the message writes too** — the second step of `docs/plans/2026-09-30-services.md`.
  `services.messages` gains `send` (a reply is a send with `replyTo`), `edit`, `delete`, `forward`,
  `pin`, `unpin` and `react`, each through the send guard. `messages send|reply|edit|delete|forward|pin|unpin`,
  `reactions add|remove` and the MCP write tools call them. The internal `guarded*` helpers are gone;
  `DELETE_AT_ONCE` now comes from `src/services/`. Nothing a person or a script sees changes.
- **Chat members in the store** (store version 7): `saveMembers(key, chatId, ids)` replaces who is in
  a chat with the list given, `members(key, chatId)` reads them back by name, and
  `chatsWith(key, id)` lists the chats a person is in, newest first. Additive: a build on version 6
  keeps working on the file.

## 0.54.0 — 30.09.2026

### Fixed

- **A deletion that names no chat skips a Telegram supergroup or channel the store knows only by its id.**
  0.52.0 recognised them by their kind or chat type; a chat first seen through one of its messages has
  neither yet, but its id is marked `-100…`. Only Telegram accounts are affected; other providers as before.
- **A message the store marked deleted by mistake comes back on the next read that returns it.**
  `saveMessages` takes `seenAt`, when the messenger was asked; a tombstone older than that is lifted and
  the message is searchable again, a newer one stays. `history`, `around` and live edits pass it, so the
  messages an earlier version wrongly marked deleted reappear once their chat is read again.

## 0.53.0 — 30.09.2026

### Added

- **`messages download <chat> --all`** saves every file of a chat into `--output`, newest first, page
  by page with a `--pace` between pages (1 s). Messages with no file cost no download request. It is
  resumable: the stretches of messages already walked are kept in `.download-<chat>.json` beside the
  files, written after every file, so a run cut short by `--timeout` or Ctrl-C repeats at most the file
  it was in; running it again jumps over what is done and picks up newer messages too. Rate limits
  ("wait N seconds") up to five minutes are sat out. File names are as for one message; a name another
  message already took gets the message's prefix (`<id>-<n>-<name>`), and nothing is overwritten.
  `<message>` is now optional, and refused beside `--all`. No MCP tool: it runs long, and
  `<cli>_messages_download` covers one message.

## 0.52.0 — 30.09.2026

### Fixed

- **A deletion that names no chat no longer hides messages in other chats.** Telegram reports a
  deletion in a private chat or a basic group by message id alone. The store used to mark every
  message of the account with that id as deleted, channels and supergroups included, where the same
  id is a different message. Now it skips channels and supergroups, and skips the deletion when the
  id still matches more than one message.

## 0.51.0 — 30.09.2026

### Added

- **Services: each use case once, for commands and MCP tools alike** — the first step of
  `docs/plans/2026-09-30-services.md`. `withServices` on the messenger context
  hands a command `services.messages` (`list`, `around`, `search`), which chooses between the
  messenger and the store; it opens the connection or the store only when asked, and closes them
  after. `messages list|context|show|search` and the MCP read tools use it. Nothing a person or a
  script sees changes.

### Fixed

- **A local model no longer drops quietly spoken speech.** The voice detector that cuts a recording
  into pieces took a quiet stretch for silence and threw it away: in a 19-second voice message both
  GigaAM and Parakeet lost the middle 10 seconds that Telegram heard. Its threshold goes from 0.5 to
  0.3. Transcripts a local model kept before are forgotten once, so `--transcribe` hears them again;
  the messenger's are kept.

## 0.50.0 — 30.09.2026

### Added

- **`pollsCommand` — `polls show|vote|close|create`**, max-cli's. `show` answers a poll (`Poll`,
  `PollAnswer`) with each answer's id; `vote <chat> <message> <answer ids...>` votes by those ids, never
  by position, and `--retract` takes the vote back; `close` closes the owner's own poll; `create <chat>
  <question> <answers...> [--multiple] [--anonymous] [--silent] [--send-id]` sends one, public unless
  `--anonymous`. The send guard checks a vote as a `reaction`, closing as an `edit` and a new poll as a
  `message` with a send id, so a retry after an unknown outcome is safe. MCP: `<cli>_polls_show` reads;
  `--allow-send` adds `<cli>_polls_vote`, `_close` and `_create`. An adapter offers the optional
  `poll`, `vote`, `closePoll` and `createPoll`; a CLI adds the command group itself.

## 0.49.0 — 30.09.2026

### Changed — may break callers

- **Store version 6, and builds before it refuse the file.** `min_compatible` rises to 6: a tg or
  max built on an earlier cli-messaging opens an upgraded `messages.db` only to say «the message
  store was written by a newer version … — upgrade this tool». Release a CLI's bump of this package
  together with the other's, then upgrade both: `npm install -g @leemour/tg-cli@latest
  @leemour/max-cli@latest`. Version 6 adds `chats.username`, `membership_state`, `is_searchable` and
  `message_count` (kept by triggers), and `messages.normalized_text` with `normalizer_version`. The
  upgrade holds the write lock for about 0.4 s on a million messages.

### Added

- **Every saved message keeps a normalized copy of its text** — accents and marks removed, ё as е,
  lowercase, whitespace collapsed — for the word search to come; the original text is untouched. A
  deleted message gets none. Messages stored before version 6 are filled on the first open when
  there are at most 5,000 of them; a larger store is filled by `db migrate`, still to come, and
  nothing reads the copy before then.
- **`Chat.membershipState`** (`joined`, `left`, `public`, `imported`, `archived`, `external`), absent
  where the messenger does not say. The store keeps the last one it was told.

## 0.48.0 — 30.09.2026

### Added

- **`messages delete <chat> <messages...> [--for-everyone] --allow-dangerous`**, max-cli's: at most 10
  messages, for the owner only unless `--for-everyone`, and nothing without `--allow-dangerous` — no
  prompt asks instead. The send guard checks it as a `delete` and counts each message toward the hourly
  limit. The answer is `{ chatId, deleted, forEveryone }`. An adapter offers it with the optional `delete`.
- **`mcp --allow-delete`** offers `<cli>_messages_delete`, which deletes the owner's own copy only; for
  everyone is the command's alone. `--allow-send` does not imply it, and `mcp config` carries it.
  `ServerOptions` and `McpFlags` gain `allowDelete`, and `--confirm-send` is accepted with it alone.

## 0.47.0 — 30.09.2026

### Added

- **`topicsCommand` — `topics list <chat>` and `topics search <chat> <text>`** and the `topics_list`
  tool: a forum group's topics, newest activity first, paged, each with the id its messages carry as
  `threadId` (type `Topic`). Telegram has forums, MAX does not. A messenger offers it with the
  optional `topics`; a CLI adds the command group to its program.
- **`chats inspect <link>`**, max-cli's, and the `chats_inspect` tool: what an invite or public link
  leads to, read without joining — `LinkTarget`: kind, title, id (`null` for a private chat the owner
  is not in), members, description, whether the owner is already in it, and whether joining needs
  approval. A messenger offers it with the optional `inspect`.
- **Voice messages carry their text in `messages list` and `inbox`.** A transcript heard once is kept
  per profile in the CLI's own cache (`transcripts-<profile>.db`, not the store) and shows on every
  later read as `transcript` — under the text, with 🎤, for a person. `--transcribe` hears the rest —
  by the messenger or a model on this machine, as `messages transcribe` chooses — within two minutes
  for the whole list; what is left is in `unheard`, never a failure. `transcribe` on the list and
  inbox tools does the same. `messages transcribe` keeps what it hears too.

### Fixed

- **`config show` says `transcribeWith` is `auto` when unset**, not `null`.

## 0.46.0 — 30.09.2026

### Added

- **`chats read <chat> [--until <message>]`** marks a chat read, to its newest message or to the one
  named; the other side sees it. The MCP tool `<cli>_chats_read` is offered only with the new
  `mcp --allow-mark-read`, which `--allow-send` does not imply, and `mcp config` carries the flag. The
  send guard checks it as a `read`, which never counts toward the hourly limit. The answer is
  `{ chatId, until }`. An adapter offers it with the optional `markRead`.

### Changed — may break callers

- **`--confirm-send` is accepted with `--allow-mark-read` alone**; it refused anything but `--allow-send`.
  `ServerOptions` and `McpFlags` gain `allowMarkRead`.

## 0.45.0 — 29.09.2026

### Added

- **`account sessions list`**, max-cli's, and the `account_sessions` tool: every device and app logged
  in to the account — `current`, `client`, `device`, `location`, `lastActiveAt` (type
  `AccountSession`). It reads only. A messenger offers it with the optional `sessions`; `account
  sessions` is a command group of its own file, for `end-others` to join.

## 0.44.0 — 29.09.2026

### Added

- **`reactionsCommand` — `reactions add <chat> <message> <emoji>` and `reactions remove <chat> <message>`**,
  and with `--allow-send` the MCP tools `<cli>_reactions_add` and `<cli>_reactions_remove`. The send guard
  checks them as a `reaction`, which never counts toward the hourly limit; the confirmation form shows
  the emoji. The answer is `{ chatId, messageId, reaction }`, `null` once taken off. An adapter offers it
  with the optional `react`; a CLI adds the command group itself.

## 0.43.0 — 29.09.2026

### Added

- **`server status` says when the running `serve` is older than the CLI** — "It runs tg 0.8.0, and tg
  is now 0.9.0 — `tg server restart`", as max-cli's does; `--json` gains `version`. `serve` records its
  version in the lock. **`servingProfiles(app, env)`** names the profiles a serve runs for, for an
  update to restart.
- **`messages send --file <path>` and `--photo <path>`**, the text as the caption, and `file` and
  `photo` on the MCP send tool. A file is read before connecting, with max-cli's rule: hidden files
  and folders (`~/.ssh`), the CLI's own folders and the message store file are refused — the command takes
  `--allow-any-file`, the MCP tool never does. The journal records each attachment's kind and size,
  never its name. An adapter receives them as `SendOptions.attachments` (`Upload`: kind, name, bytes);
  `readUpload` is exported from `./sends`.

## 0.42.0 — 29.09.2026

### Changed — may break callers

- **Speech models move to `~/.cache/cli-common/models/audio`**, a folder named for the whole family of
  CLIs rather than for this package, and `CLI_COMMON_CACHE_DIR` moves it (was `MESSAGING_CACHE_DIR`).
  A model downloaded into `~/.cache/cli-messaging/models/audio` is not found there: move the folder.

### Added

- **`contacts lookup`**, max-cli's: who has a phone number, read from stdin or asked for — **never an
  argument**, which `ps` and shell history would keep; one given anyway is refused without being
  repeated. Also the `contacts_lookup` tool. A messenger offers it with the optional `lookup`.
- **`contacts sync`**: the messenger's own contact list — the address book, not the chats — into the
  local store, answering `{ added, changed, known }`. A messenger offers it with the optional
  `addressBook`.

- **`chats members list <chat>`**, max-cli's, and the `chats_members` tool: everyone in a group, paged
  like every listing (`--limit`, `--page`, `--all`). A member may carry `role` (`owner`, `admin`,
  `member`) and `lastSeenAt` (`null` when their privacy hides it) — type `GroupMember`. A messenger
  offers it with the optional `members`. `chats members` is its own command group, in
  `chats-members-command.ts`, for the subcommands that change membership to join.
- **`messages pin <chat> <message> [--notify]` and `messages unpin <chat> <message>`**, and with
  `--allow-send` their MCP tools `<cli>_messages_pin` and `<cli>_messages_unpin`. A pin is quiet
  unless `--notify`; the send guard checks both as a `pin`, and only a pin that notifies counts toward
  the hourly limit. The answer is `{ chatId, messageId, pinned }`. An adapter offers them with the
  optional `pin` and `unpin`.
- **`messages send --at <time>`** — the messenger sends it later: `2026-09-25T09:00` (local time) or
  `30m`, `2h`, `1d` from now, rounded down to the minute, as in max-cli. The answer carries
  `scheduledFor`, the journal counts it in the hour it goes, and the store does not keep it — it will
  arrive under another id. Refused with `--send-id`: a repeat would schedule it twice.
- **`messages scheduled <chat>`**, the MCP tool `messages_scheduled`, and `at` on the send tool. The
  confirmation form shows the clock time a delay becomes. An adapter lists the queue with the optional
  `scheduled(chat)` and receives the time as `SendOptions.at`.
- **`drizzle-orm` 1.0.0-rc.4 is a dependency** (about 16 MB installed), for the store's move to
  Drizzle. Nothing loads it yet, so no command changes and startup time stays the same.

## 0.41.0 — 29.09.2026

### Added

- **`chats events <chat> [--since] [--event join,leave,…]`**, max-cli's, and the `chats_events` tool:
  who joined, left, was added or removed, and by whom — plus `create`, `title` and `pin` — from the
  chat's service messages, oldest first, seven days back without `--since`. A messenger offers it
  with the optional `chatEvents` (types `ChatEvent`, `ChatEvents`); `more` says one run did not reach
  back to `--since`.

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
