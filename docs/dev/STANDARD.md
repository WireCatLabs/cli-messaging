# The standard for tg and max

tg-cli and max-cli are one tool with two messengers behind it. This page holds the rules that make
them one: how a command, an option, an answer and an MCP tool are named and shaped, where code
lives, and which documents each has. It lives here because this package is where the two meet;
both CLIs' `CONVENTIONS.md` link it instead of keeping a copy.

How a pull request is checked against these rules is [REVIEW.md](REVIEW.md).

A rule changes here first, in its own pull request, and the owner approves new wording — a new verb
or option name especially. Then the code follows. A difference between the two CLIs is allowed only
where one messenger lacks the feature, and it is written down with its reason in the
[parity manifest](#the-parity-manifest).

## Command names

A name a person reads once should say what the command does; a name an agent reads should be
guessable from the others.

1. **`<tool> [profile] <resource> <verb> [arguments]`.** The resource is a noun: **plural** for a
   collection (`chats`, `contacts`, `messages`, `polls`, `reactions`, `recipients`, `replies`, `sends`,
   `runs`, `topics`, `models`, `tags`, `searches`, `copies`), **singular** for what a profile has exactly
   one of (`session`, `account`, `config`, `server`, `store`, `skill`, `cache`, `flood`). A group is never
   named with a verb. `tags` and `searches` are the owner's own records in the local store, never
   sent; their writes have their own keys (`tags.add`), so a read-only profile hides them.
2. **Top-level words** only for what spans every chat or is the tool itself: `inbox`, `review`,
   `watch`, `serve`, `doctor`, `upgrade`, `commands`, `complete`, `mcp`, `bot`. A new one needs a
   reason in its pull request.
3. **Verbs come from this list, each with one meaning.** A verb not on it is added here first.
   - `list` many · `show` one · `search` find by text — the description says where it looks
   - `related` what is nearest in meaning to one thing, without a query (`conversations related`)
   - `info` facts about a singular thing itself — where it is, its size, its version, its schema
     (`store info`) · `status` how a thing stands right now — a running process (`server status`)
     or what the store holds per chat (`store status`)
   - `check` verify, and change nothing — the answer says what is wrong and how to fix it
     (`store check`)
   - `test` run rules over what is already stored and say what they would have done, doing none of
     it (`replies test`)
   - `create` / `delete` make or destroy a thing · `add` / `remove` put an existing thing into or
     out of a set (members, admins, contacts, recipients, reactions) · `clear` empty a set
   - `update` change a thing's fields · `set` / `unset` one named key · `rename` its name only
   - `start` / `stop` / `restart` a running process · `start` / `end` a login session
     · `install` / `uninstall` a system unit · `cancel` a job
   - `fetch` from the messenger into the store · `export` from the store to a file · `import` ·
     `download` · `transcribe` · `sync` take a whole list again
   - `migrate` bring a file up to this build's schema · `backup` copy it somewhere safe ·
     `restore` put a backup back in its place · `repair` bring a file's tables to this build's shape
     without deleting anything — a table of the wrong shape is kept as a copy (`store repair`, its copies
     in `store copies`)
   - `link` / `unlink` record in the store that two identities are one person, or undo it — a
     decision someone made, never inferred from a name (`contacts link`)
   - `lookup` ask the messenger who is behind a phone number · `inspect` look at a link without
     joining it
   - the messenger's plain verbs: `send`, `edit`, `forward`, `pin`, `unpin`, `vote`, `close`,
     `join`, `leave`, `block`, `unblock`, `mark-read`, `reset` (replace; the old one stops
     working), `moderate` (apply a chat's rules: delete what breaks them, act on who broke them)
   - A **noun as the last word** names a view and shows it: `server logs`, `chats events`,
     `messages scheduled`, `messages context`, `runs path`, `mcp config`, `searches history`.
4. **One action, one command.** A variant is an option, never a sibling command, and no command
   both shows and changes.
5. **Options are plain words, never a wire field** (`--send-id`, not `--cid`). One meaning, one
   name, in every command of both tools. **A length of time is a `<duration>`** (`500ms`,
   `30s`, `2m`, `4h`, `1d`) — a number and a unit, never a bare number — parsed as `--timeout`
   is; `--since-time` takes a duration or a time.
   - **The kind of value is in the name** of every option that takes a time, and of one that marks
     a place in a history or a count around it: `-id` a message id, `-time` an ISO 8601 time or a
     duration from now or ago, `-n` a count — `--before-id`, `--after-time`, `--since-time`,
     `--at-time`, `--before-n`. Two kinds, two options, never one
     option that guesses which it was given.
   - **How much, in a list or a fetch:** `--limit <n>` how many items, `--page <n>` which page,
     `--page-size <n>` how many one request to the messenger asks for. A count of pages is never an
     option: it means a different amount in each messenger.
6. **Arguments have fixed names:** `<chat>`, `<message>`, `<person>`, `<text>`, `<link>`,
   `<file>`, `<job>`.
7. **One word per idea** in help, docs and errors. The **local store** is the message database
   both tools share; max's per-profile **cache** is a different thing until it is replaced, and
   keeps its name until then. `session` is this tool's login; `account sessions` are the other
   devices. **`flood`** is what the messenger told this profile to hold off on — the waits it asked
   for and a hold on writes — kept on this machine; `flood clear` is the owner's and has no MCP tool.
8. **An MCP tool is named after its command** — see [MCP](#mcp).
9. **No aliases.** A renamed command's old name stops working, and the release notes say so under
   "may break scripts".

10. **`bot` is the profile's bot account**, through the messenger's official Bot API and a bot
    token — never the personal login. Below it, a command the personal account also has takes the
    same name, arguments and options: `bot messages send`, `bot messages show <chat> <message>`,
    `bot chats members remove`, `bot chats moderate`, `bot contacts show`, `bot watch`. What only a
    bot has: `bot auth`, `bot list`, `bot callbacks`, `bot commands` (the menu people see on `/`),
    `bot webhooks`, `bot uploads`, `bot api`. A bot's send is never repeated — neither Bot API makes
    a repeat safe — so `bot messages send` has no `--send-id`. A bot command may add an option only a
    bot has, as `bot watch --types` does.

`bot api` is exempt: its names mirror each messenger's official Bot API operations.

Generated `bot api` commands use cli-core's generators and one command assembler in cli-messaging.
Only the source-specification adapter, transport and provider capabilities stay in the consumer.
Common inputs are `--body <json>` and `--body-file <path>`; `-` reads stdin. A native `timeout`
parameter is `--poll-timeout`, so it cannot replace the command's `--timeout` deadline.
Schema-declared file fields accept `@path`; ordinary strings never trigger a file read.

This advanced interface returns the official operation's native result, preserving MAX's existing
API contract. The normal bot commands use the shared domain output shapes. Both native interfaces
still use the common machine error contract, the profile's guard and send journal; a write with an
unknown outcome is never repeated automatically.

`--store-token <profile>` names the destination for an operation returning an authentication token.
It is required for those operations and rejected for other operations. The token is kept only in the
OS keyring and never printed; the result names the destination profile, bot id and storage kind.
A destination bound to a different bot is refused before a remote credential rotation. Secret
request fields have no generated argument flags: supply their JSON on stdin or in an existing
protected file. Tokens never enter diagnostics, traces or run records.


## Option catalogue

Every option of both tools, once: its value, what it means, its default and the commands that take
it. An option means one thing wherever it appears; a new one is added to `parity.json` first, with
its meaning, and this table is regenerated from it. **Bold** marks a clash still to resolve.

<!-- option catalogue: generated by `pnpm parity:render` from parity.json -->

| Option | Value | Meaning | Default | Commands |
|---|---|---|---|---|
| `--accept-terms` |  | accept the model's licence terms, for a model that has its own |  | `models text download` |
| `--add` | `<chat>` | put a chat into a folder; repeat it for more |  | `bot webhooks set` (max-only), `chats folders update` |
| `--after-id` | `<id>` | read what came after this message id; not with --after-time or the --before pair |  | `messages list` |
| `--after-n` | `<n>` | how many messages after it |  | `messages context` |
| `--after-time` | `<time>` | read what came after this ISO 8601 time, or 2h / 1d ago; not with --after-id or the --before pair |  | `messages list` |
| `--agent` | `<agent>` | install the skill for this agent; asks at a terminal, otherwise none |  | `setup` (planned) |
| `--all` |  | every row, no paging |  | `chats list`, `chats members list` (planned), `contacts list`, `inbox` (planned), `messages download`, `review` (planned), `store export` |
| `--all-bots` |  | also read every other bot's copy on this machine that readOtherBots allows |  | `bot contacts show`, `bot messages between`, `bot messages search` |
| `--all-can-pin` | `<on\|off>` | every member may pin messages |  | `chats update` |
| `--allow-any-file` |  | send a --file even from a hidden folder, ~/.ssh or the tool's own folders |  | `bot messages send`, `messages send` |
| `--allow-dangerous` |  | go ahead without the question an ask level puts before a deletion |  | `bot chats moderate`, `bot mcp`, `bot mcp config`, `bot messages delete`, `chats moderate` (planned), `mcp` (planned), `mcp config` (planned), `mcp doctor` (planned), `mcp setup` (planned), `messages delete`, `store clear` |
| `--allow-delete` |  | offer the tool that deletes messages for you only; it cannot be undone. **retired access flag: accepted with a warning, grants no permissions in either CLI** |  | `bot mcp`, `bot mcp config`, `mcp`, `mcp config`, `mcp doctor` (planned), `mcp setup` (planned) |
| `--allow-mark-read` |  | offer the tool that marks a chat read; the other person sees it. **retired access flag: accepted with a warning, grants no permissions in either CLI** |  | `mcp`, `mcp config`, `mcp doctor` (planned), `mcp setup` (planned) |
| `--allow-moderate` |  | offer the tool that applies a group's rules — delete others' messages, remove people. **retired access flag: accepted with a warning, grants no permissions in either CLI** |  | `bot mcp`, `bot mcp config`, `mcp` (planned), `mcp config` (planned), `mcp doctor` (planned), `mcp setup` (planned) |
| `--allow-send` |  | offer the send tool; without it the server can only read. **retired access flag: accepted with a warning, grants no permissions in either CLI** |  | `bot mcp`, `bot mcp config`, `mcp`, `mcp config`, `mcp doctor` (planned), `mcp setup` (planned) |
| `--allow-writes` |  | acknowledge that the profile offers writing tools when installing local MCP |  | `mcp setup` (planned) |
| `--anonymous` |  | nobody sees who voted for what |  | `polls create` |
| `--app` | `<how>` | the first time only: how to get this profile's app from my.telegram.org | `browser` | `session start` (tg-only), `setup` (planned) |
| `--as-file` |  | send every --file as a plain file to download, a video included |  | `bot messages send`, `messages send` |
| `--at-time` | `<time>` | let the messenger send it later, even with this machine off: a local time like 2026-09-25T09:00, or 30m |  | `messages send` |
| `--background` |  | run as a job that outlives this command; `store jobs show` follows it |  | `store fetch` |
| `--base-url` | `<url>` | a server with OpenAI's /v1/embeddings: Gemini, Jina, or Ollama and LM Studio on this machine |  | `conversations embed`, `conversations embed clear`, `conversations embed status`, `conversations related` (planned), `conversations search`, `conversations status` (planned) |
| `--batch` | `<id>` | the batch id `conversations batches next` printed |  | `conversations links add` (planned) |
| `--before-id` | `<id>` | read what came before this message id; not with --before-time |  | `messages evidence`, `messages list` |
| `--before-n` | `<n>` | how many messages before it |  | `messages context` |
| `--before-time` | `<time>` | read what came before this ISO 8601 time, or 2h / 1d ago; not with --before-id |  | `messages list` |
| `--block` | `<value>` | Set to `true` if user should be blocked in chat. |  | `bot chats members remove` |
| `--bot` |  | the bot section of the profile's settings, rather than the personal account's |  | `config set` (planned), `config show` (planned), `config unset` (planned) |
| `--bots` | `<profiles>` | also read these bots' copies, comma separated — each allowed by readOtherBots |  | `bot contacts show`, `bot messages between`, `bot messages search` |
| `--budget` | `<pages>` | at most this many pages of a list, with a pause between them |  | `chats members audit` (planned) |
| `--by` | `<grouping>` | what to count by. **each command names its own groupings — messages stats chat, sender, day or hour, and searches create the same for messages stats --saved; chats stats day or week, as a series beside its totals — so it differs on purpose (Help text rule 4)** |  | `chats stats` (planned), `messages stats` (planned), `searches create` (planned) |
| `--can` | `<rights>` | what they may do, comma-separated: read, members, admins, info, pin, link, post, edit, delete. **lists the rights each messenger has — MAX has `read`, Telegram does not — so it differs on purpose (Help text rule 4)** |  | `bot chats admins add`, `chats admins add` |
| `--channel` |  | a private channel instead of a group; people join it by its link |  | `chats create` |
| `--chat` | `<chat>` | a chat, by id or name; repeat it for more. **chat addressing follows each messenger's supported names, usernames and Saved Messages aliases, so it differs on purpose (Help text rule 4); both message searches resolve stored names without networking** |  | `chats folders create`, `conversations batches next`, `conversations batches status`, `conversations build`, `conversations embed`, `conversations embed clear`, `conversations embed status`, `conversations links clear` (planned), `conversations list`, `conversations search`, `conversations status` (planned), `messages search`, `messages stats` (planned), `review`, `searches create` (planned), `tags add` (planned), `tags remove` (planned) |
| `--check` |  | say whether a newer version exists, and install nothing |  | `bot list`, `upgrade` |
| `--concurrency` | `<n>` | remote: requests at once (default: 4) |  | `conversations embed` |
| `--confirm-send` |  | show the owner every write the MCP server offers, in a form to approve. **MAX retains its native wrapper wording; confirmation semantics already follow profile permissions in both CLIs** |  | `bot mcp`, `bot mcp config`, `mcp`, `mcp config`, `mcp doctor` (planned), `mcp setup` (planned) |
| `--contact` | `<person>` | the person to tag or untag: their id, @username or name, as the local store knows them |  | `tags add` (planned), `tags remove` (planned) |
| `--context` | `<n>` | messages before and after each hit |  | `messages search`, `searches create` (planned) |
| `--defaults` |  | change what every profile gets, rather than this profile |  | `config set`, `config unset` |
| `--description` | `<text>` | the new about text — of a chat or of your account |  | `account update`, `chats update` |
| `--dims` | `<n>` | remote: the vector size — needed with --base-url; shortens an OpenAI model's |  | `conversations embed`, `conversations embed clear`, `conversations embed status`, `conversations related` (planned), `conversations search`, `conversations status` (planned) |
| `--dry-run` |  | judge and plan; do nothing |  | `bot chats moderate`, `chats moderate` (planned), `config migrate`, `store repair` (planned) |
| `--encrypt` |  | compress and encrypt with a password, typed at a hidden prompt or piped on stdin; never kept |  | `store backup`, `store export` |
| `--estimate` |  | only say what the fetch would cost, from this machine's copy; nothing is sent. **max's own copy is worded differently until T6 moves the command onto the shared one (e13)** |  | `store fetch` |
| `--events` |  | also print edits, deletions and reactions; every line then names its event. **watch updates use this flag independently of the group event --type filter** |  | `bot watch`, `watch` |
| `--file` | `<file>` | attach a file; images go as a photo, videos as a video. Repeat it for more |  | `bot messages send`, `messages send` |
| `--first-name` | `<name>` | your first name |  | `account update` |
| `--for` | `<agents>` | which agents a skill is installed for: claude, agents or all | `all` | `skill install` (planned) |
| `--for-everyone` |  | delete for everyone in the chat, not only for you — they cannot get it back |  | `messages delete` |
| `--format` | `<format>` | jsonl, one message per line, or a markdown transcript. **the shared `store export` takes `jsonl` or `markdown`, max's own takes `jsonl` or `md` (e4)** |  | `store export` |
| `--from` | `<who\|link>` | sender to match in bot messages search; starting message link in tg bot store fetch |  | `bot messages search`, `bot store fetch` (tg-only) |
| `--history` |  | the people added also see the messages from before they came |  | `chats members add` (max-only) |
| `--html` |  | the text is HTML: <b>, <i>, <a href>, <code> |  | `bot messages edit`, `bot messages send` |
| `--http` |  | serve MCP over HTTP on 127.0.0.1 behind the owner's tunnel, with a one-owner login; every write asks first |  | `mcp` |
| `--idle` | `<duration>` | stop after this long with nobody using it — 15m, 1h |  | `serve` (max-only), `server restart` (max-only), `server start` (max-only) |
| `--json` |  | machine-readable output: one JSON value on stdout, nothing else |  | every command |
| `--jsonl` |  | machine-readable output: one JSON object per line, for streaming and jq |  | every command |
| `--kind` | `<kind>` | only chats of this kind: dialog, group, channel or saved |  | `chats list`, `inbox`, `review`, `store export` |
| `--language` | `<lucene\|legacy>` | the query language: strict Lucene or legacy discovery | `lucene` | `messages search`, `searches create` (planned) |
| `--last` | `<n>` | stop once the newest n messages are held; not with --since. **max's own copy is worded differently until T6 moves the command onto the shared one (e13)** |  | `bot store fetch`, `store fetch` |
| `--last-name` | `<name>` | your last name |  | `account update` |
| `--left` |  | only the chats this account has left |  | `store clear` |
| `--limit` | `<n>` | how many: rows to show, or messages one run fetches. **max's own copy is worded differently until T6 moves the command onto the shared one (e13)** |  | `bot chats members list` (max-only), `bot contacts show`, `bot messages between`, `bot messages list`, `bot messages search`, `bot store fetch`, `chats list`, `chats members list` (planned), `contacts context` (planned), `contacts list`, `conversations list`, `conversations related` (planned), `conversations search`, `inbox`, `messages evidence`, `messages list`, `messages search`, `messages stats` (planned), `runs list`, `searches create` (planned), `searches history` (planned), `sends list`, `store fetch` |
| `--lines` | `<n>` | how many lines | `50` | `server logs` |
| `--local` |  | use the model on this machine, never the messenger |  | `messages transcribe` (tg-only) |
| `--mark-read` |  | also mark the chat read up to the newest message shown; the other person sees it |  | `inbox`, `messages list`, `review` |
| `--marker` | `<value>` | Marker |  | `bot chats members list` (max-only) |
| `--max-actions` | `<n>` | at most this many actions in one run | `10` | `bot chats moderate`, `chats moderate` (planned) |
| `--max-chats` | `<n>` | at most this many chats in one run | `20` | `conversations build` (planned), `conversations embed` (planned), `conversations search` (planned) |
| `--max-chunks` | `<n>` | at most this many chunks embedded in one run | `2000` | `conversations embed` (planned), `conversations search` (planned) |
| `--max-tokens` | `<n>` | remote: stop before a run that could send more tokens than this |  | `conversations embed` |
| `--md` |  | read this messenger's Markdown; see its formatting guide for supported syntax |  | `bot messages edit`, `bot messages send`, `messages edit`, `messages send` |
| `--members-see-link` | `<on\|off>` | members may see the invite link |  | `chats update` (max-only) |
| `--message` | `<message>` | the message to tag or untag: its id in --chat, or a msg: locator alone |  | `tags add` (planned), `tags remove` (planned) |
| `--method` | `<method>` | how to log in when there is no session |  | `setup` (planned) |
| `--min-score` | `<n>` | only rows scoring at least this |  | `chats members audit` (planned) |
| `--model` | `<id>` | which downloaded speech model hears them; `models audio list` shows them. **max's own copy is worded differently until T6 moves the command onto the shared one (e13)** |  | `conversations embed`, `conversations embed clear`, `conversations embed status`, `conversations links clear` (planned), `conversations related` (planned), `conversations search`, `conversations status` (planned), `inbox`, `messages list`, `messages transcribe`, `review` (planned) |
| `--multiple` |  | people may pick several answers |  | `polls create` |
| `--new` |  | what arrived since the last check, each message once — for scheduled runs |  | `inbox`, `review` |
| `--newest` |  | newest first instead of best first |  | `bot messages search`, `messages search`, `searches create` (planned) |
| `--no-ban` |  | remove without banning; by default a removed person cannot come back by the link |  | `bot chats moderate` |
| `--no-mark-read` |  | do not mark read, whatever the catchUpMarksRead setting says |  | `inbox`, `review` |
| `--no-preview` |  | no preview card for a link in the text |  | `messages send` |
| `--no-record` |  | do not keep it, whatever the configuration says |  | every command |
| `--no-serve` |  | do not start it; log in on this command's own connection unless one is running |  | every command (planned) |
| `--notification` | `<text>` | a note only the person who pressed sees |  | `bot callbacks answer` |
| `--notify` |  | tell the chat's members about the pin |  | `bot messages pin`, `messages pin` |
| `--offline` |  | answer from what was recorded and never connect; fails if nothing was |  | every command |
| `--online` |  | also log in once, read one chat and start the MCP server; sends nothing. **max's own copy is worded differently until T6 moves the command onto the shared one (e13)** |  | `doctor` |
| `--only-admins-add` | `<on\|off>` | only admins may add members |  | `chats update` |
| `--only-admins-call` | `<on\|off>` | only admins may start a call |  | `chats update` (max-only) |
| `--only-owner-edits-info` | `<on\|off>` | only the owner may change the name and photo |  | `chats update` (max-only) |
| `--order` | `<recent\|name>` | newest conversation first, or alphabetical |  | `contacts list` |
| `--others` |  | every session but this one. **max's own copy is worded differently until T6 moves the command onto the shared one (e13)** |  | `account sessions end` |
| `--output` |  | where to write: a directory for `messages download`, a file for `store export`. **MAX `messages download --output <dir>` remains a compatibility alias for `--output-dir`; other commands use --output for a file — e10** | `.` | `doctor report create`, `messages download` (max-only), `store decrypt`, `store export` |
| `--output-dir` | `<dir>` | the folder to write into, created if missing | `.` | `messages download` |
| `--page` | `<n>` | which page, starting at 1 |  | `chats list`, `chats members list` (planned), `contacts list` |
| `--page-size` | `<n>` | how many items one request to the messenger asks for; the messenger's own if not given. **the default is each messenger's own page: 30 on MAX, 100 on Telegram** |  | `bot store fetch`, `store fetch` |
| `--pause` | `<duration>` | the least wait between pages, 5s or 500ms; each is up to twice that. **max's own copy is worded differently until T6 moves the command onto the shared one (e13)** | `5s` | `bot store fetch`, `messages download`, `store fetch` |
| `--personal` |  | the personal account's section of the profile's settings |  | `config set` (planned), `config unset` (planned) |
| `--photo` | `<file>` | an image file — a profile photo in `account update`, a photo to send in `messages send` |  | `account update`, `bot messages send`, `messages send` |
| `--port` | `<port>` | the local port for --http |  | `mcp` |
| `--provider` | `<provider>` | embed through a service with your key instead of on this machine: openai |  | `conversations embed`, `conversations embed clear`, `conversations embed status`, `conversations related` (planned), `conversations search`, `conversations status` (planned) |
| `--public-url` | `<url>` | the tunnel's https address the browser apps use |  | `mcp` |
| `--qr-file` | `<png>` | write the QR code to this PNG instead of drawing it, for an agent to pass on |  | `session start` (tg-only), `setup` (planned) |
| `--quiet` |  | diagnostics off. **max's own copy is worded differently until T6 moves the command onto the shared one (e13)** |  | every command |
| `--record` |  | keep this run under `runs` — ids and timings, never message content. **max's own copy is worded differently until T6 moves the command onto the shared one (e13)** |  | every command |
| `--refresh` |  | read the private chat with them from MAX first — one request. **one idea, two sources: bring what the answer is read from up to date first. `bot contacts show` reads the private chat again from the messenger; `conversations search` builds and embeds, on this machine, the chats that changed (NEED-551 A, awaiting the owner's wording)** |  | `bot contacts show`, `conversations search` (planned) |
| `--regex` |  | the words are one regular expression, case-insensitive, tested against every stored text |  | `messages search`, `searches create` (planned) |
| `--remove` | `<chat>` | take a chat out of a folder; repeat it for more |  | `chats folders update` |
| `--replace` |  | overwrite a saved search of the same name |  | `searches create` (planned) |
| `--reply-to` | `<message>` | answer this message id in the same chat |  | `bot messages send`, `messages send` |
| `--retract` |  | take your vote back, where the poll allows it |  | `polls vote` |
| `--revoke` |  | forget every login given to a browser app over --http |  | `mcp` |
| `--revote` |  | people may change their vote |  | `polls create` |
| `--run` | `<id>` | the run the report is about; the newest failed one if not given |  | `doctor report create` |
| `--saved` | `<name\|id>` | run a saved search, or an earlier run by its id; options typed with it replace its own, more words are AND-ed |  | `messages search` (planned), `messages stats` (planned) |
| `--search` | `<text>` | only chats whose name contains this; at least 3 characters |  | `chats list`, `contacts list` |
| `--secret-stdin` |  | a secret MAX sends back in X-Max-Bot-Api-Secret — asked for, or read from a pipe |  | `bot webhooks set` |
| `--send-id` | `<id>` | identify a send or creation attempt; message/poll retries reuse it, while an unknown topic creation must never be repeated |  | `messages forward`, `messages send`, `polls create`, `topics create` (tg-only) |
| `--serve` |  | start `serve` in the background if it is not running (the default) |  | every command (planned) |
| `--show-phone` |  | print the whole phone number |  | `account show` |
| `--silent` |  | deliver without a notification |  | `bot messages send`, `messages forward`, `messages send`, `polls create` |
| `--since` | `<id-or-time>` | from this message id, an ISO 8601 time, or 2h / 1d ago; each command says its default. **becomes `--since-time` everywhere — NEED-485** |  | `inbox` (planned), `review` (planned) |
| `--since-time` | `<time>` | from this ISO 8601 time, or 2h / 1d ago; each command says its default |  | `bot chats moderate`, `bot store fetch`, `chats events` (planned), `chats moderate` (planned), `chats stats` (planned), `contacts context` (planned), `conversations list`, `conversations search`, `inbox` (planned), `replies test` (planned), `review` (planned), `store export`, `store fetch` |
| `--size` | `<n>` | messages to answer per batch, 10–200; 50 by default |  | `conversations batches next`, `conversations batches status` |
| `--source` | `<messenger>` | every account of this messenger held in the store; personal, bots or all — the same as in: in the query |  | `messages search`, `messages stats` (planned), `searches create` (planned) |
| `--store-token` | `<profile>` | keep a returned authentication token only in this bot profile's OS keyring; never print it |  | `bot api` |
| `--tag` | `<tag>` | only this tag |  | `tags list` (planned) |
| `--text` | `<text>` | the message's new text; - reads stdin |  | `bot callbacks answer` |
| `--threads` | `<n>` | threads in all | `min(8, cores)` | `conversations embed` |
| `--timeout` | `<duration>` | give up on the whole command after this — 30s, 2m, 500ms |  | every command |
| `--timezone` | `<zone>` | the IANA timezone for calendar date boundaries | `system IANA timezone` | `chats stats` (planned), `messages search`, `messages stats` (planned), `searches create` (planned) |
| `--title` | `<title>` | the new name — of a chat or a folder |  | `bot chats admins add`, `chats folders update`, `chats update` |
| `--to` | `<chat>` | the chat to forward it to: an id, or part of a chat name. **the sentence says how to name a chat the messenger's way, so it differs on purpose (Help text rule 4)** |  | `messages forward`, `store export` |
| `--topic` | `<id>` | send to this forum topic. **Telegram group forums only; MAX explicitly refuses this option before sending** |  | `messages send`, `polls create` |
| `--trace` |  | one line per request on stderr: ids and timings, never message content. **max logs one line per request, tg the connection's own lines: the same option, a different mechanism (Help text rule 4)** |  | every command |
| `--transcribe` |  | hear voice messages not heard yet, on this machine; slow, the model must be downloaded. **max's own copy is worded differently until T6 moves the command onto the shared one (e13)** |  | `inbox`, `messages list`, `review` |
| `--type` | `<names>` | only these types. **each command names its own types — chats events the messenger's event types, comma-separated, as it names them; tags list chat, contact or message — so it differs on purpose (Help text rule 4)** |  | `chats events` (planned), `tags list` (planned) |
| `--types` | `<value>` | Comma separated list of update types your bot want to receive |  | `bot watch`, `bot webhooks set` |
| `--unanswered` | `[duration]` | only questions to you or a group's admins that nobody answered, asked at least this long ago — 4h, 1d. **max's own `review` still takes bare hours until T6 moves it (e2)** | `24h` | `review` |
| `--unread` |  | only chats with unread messages |  | `chats list` |
| `--until` | `<message>` | only up to this message id, inclusive; the newest by default |  | `chats mark-read` |
| `--upgrade` |  | explicitly upgrade a basic group to a supergroup before enabling topics; its chat id changes |  | `topics enable` (tg-only) |
| `--verbose` |  | more detail in what is shown: -v ids, -vv everything known | `0` | every command |
| `--version` |  | print the version number |  | every command |
| `--voice` | `<file>` | send an Ogg Opus file as a voice message, alone, with no text |  | `bot messages send`, `messages send` |
| `--workers` | `<n>` | sessions in parallel, each with its own copy of the model |  | `conversations embed` |
| `--yes` |  | go ahead without the question an ask level puts before a write |  | every command, `account sessions end` (planned), `mcp` (planned), `mcp config` (planned) |

<!-- end of the option catalogue -->

## Output

1. **Every list answers one envelope** in `--json`: `{ items, page, limit, hasMore }` —
   `renderPage` in [`src/cli/paging.ts`](../../src/cli/paging.ts) prints it. `--jsonl` streams the
   items one per line. A list never answers a bare array.
   - A list with no pages (`store status`, `server logs`) answers `page: 1`, `limit` the count and
     `hasMore: false` — `listed` in the same file.
   - A list paged by a message rather than a page number (`messages list`, `chats events`) answers
     `page: 1`; `hasMore` says whether there is more on the far side of the last item.
   - Fields about the whole list go beside the four, never instead of them (`models audio list`'s
     `directory`).
   - `inbox` and `review` are not lists: they answer one view grouped by chat, `{ chats: [{ …,
     messages }] }`, in both tools.
2. **A write answers what it did**: `{ operationId, … }`, the ids it touched after it. The same
   id is in the send journal.
3. **A one-thing view answers the object itself** (`account show`, `store info`).
4. **An error is one JSON object on stderr** in the machine modes —
   `{ "error": { "code", "message" } }` — stdout stays empty, and the exit code says which kind of
   failure it was. Commander's own parse errors (a missing argument, a missing required option)
   still print a text line and exit 1; they move to `validation_error` and 2. The codes are
   cli-core's and the same in both tools:

   | Code | Meaning |
   |---|---|
   | 0 | ok |
   | 1 | generic failure |
   | 2 | validation error — the command line is wrong |
   | 3 | configuration error |
   | 4 | authentication error |
   | 5 | permission error |
   | 6 | not found |
   | 7 | confirmation required |
   | 8 | rate limited |
   | 9 | timeout |
   | 10 | network error |
   | 11 | provider error — the messenger refused |
   | 12 | provider unavailable |
   | 13 | invalid response |
   | 14 | outcome unknown — a write may or may not have happened |
   | 130 | cancelled |

5. **A shared command answers the same shape in both tools.** What only one messenger knows goes
   under `providerMetadata`, never as a top-level field one tool has and the other lacks.
6. **`server status` answers one shape in both tools** (NEED-494 B). Not running is a result,
   `running: false`, exit 0.

   | Field | Meaning |
   |---|---|
   | `profile` | the profile asked about |
   | `running` | a server answers for it |
   | `pid` | its process |
   | `startedAt` | when it started |
   | `connected` | logged in, with updates arriving |
   | `connectedAt` | since when, where the tool knows it |
   | `by` | who started it: `unit` (systemd or launchd), `server` (`server start`), `hand` (`serve` typed in a terminal), `command` (max: a command that needed it) |
   | `version`, `cliVersion` | what the server runs, and what this tool is — they differ after an update, and a note on stderr says `server restart` |
   | `log` | where its log is |
   | `unit` | `{ name, path, installed, loaded, active, detail }` |
   | `stale` | `{ pid, startedAt }` — a lock or socket file was left by a server that is gone |

   Starting and stopping in the background is `server start` and `server stop` only; `serve` is
   the foreground command a unit or a person runs (rules 4 and 9).

## Permissions

What a profile may do is one setting, `permissions`: a JSON object whose keys are command paths and
whose values are levels. It holds for a command the owner types and for an agent over MCP alike.

```json
{ "permissions": { "messages": "allow", "messages.delete": "ask", "contacts": "readonly" } }
```

1. **Four levels.**
   - `deny` — nothing, not even reading: the command answers `permission_error` (5) before it
     connects, and an agent is not offered its tool.
   - `readonly` — reads work, writes answer `permission_error`. On a key that only writes
     (`messages.delete`) it is `deny`.
   - `ask` — in a terminal, a y/N question that shows what will change, default no. A flag skips
     it: `--allow-dangerous` for a deletion, `--yes` for every other write. With no terminal and
     no flag the command answers `confirmation_required` (7). Over MCP, a form the owner answers.
   - `allow` — goes ahead and never asks.
2. **A key is a command path**: `messages`, `messages.delete`, `chats.members.remove`,
   `account.sessions.end`. **The most specific key the owner set wins**; there is no wildcard, and a
   key starts with a resource, so a misspelled one is refused rather than ignored. Every command
   maps to exactly one key, checked by a test over `commands --json`:
   - a command that shows messages from outside `messages` counts as `messages` — `inbox`,
     `review`, `watch`, `serve`, `store fetch|export|search`, the MCP resources and prompts;
   - housekeeping is never gated — `config`, `session`, `doctor`, `commands`, `complete`,
     `upgrade`, `skill`, `models`, `server`, `runs`, `sends`, `recipients`, `mcp`, and `store`'s
     own maintenance.
3. **The defaults allow almost everything**, so the tool works without questions. Only what cannot
   be undone asks:

   ```json
   { "messages.delete": "ask", "account.sessions.end": "ask" }
   ```

   A default is never tightened without the owner's word. **A built-in default only ever tightens**:
   against a broader key of the owner's, the stricter of the two holds — `messages: readonly` still
   stops a deletion, and `messages: allow` keeps its question until `messages.delete` is named.
4. **Limits no level lifts**: an agent never deletes for everyone and never ends other sessions.
5. **A group's moderation rules use the same four levels** for each kind of action (delete,
   remove, accept, decline), `readonly` meaning "report it, do nothing". A rule's level can only be
   as loose as the profile's level for `chats.moderate`.
6. **The settings it replaces** — `readOnly`, `allow`, max's `mcpTools`, and the moderation words
   `forbid`, `flag`, `confirm` — are translated once by `config migrate`, then refused with a
   message naming the new key. The MCP flags it replaces are accepted with a warning naming the
   setting for one release, so a configured agent still starts, then go.

7. **A bot's keys are the personal ones under `bot`**: `bot.messages.send`,
   `bot.chats.members.remove`, `bot.webhooks`. A profile can allow its bot what it does not allow
   its personal account, and the other way round; `bot` alone covers every bot command. The default
   is the personal one's: `bot.messages.delete: ask`. Housekeeping under `bot` is never gated —
   `bot auth`, `bot list`, `bot recipients`, `bot sends`, `bot mcp`. The bot's old `readOnly` and
   `allow` words are translated by `config migrate` with the personal ones.

What it does not decide stays separate: the recipient list (which chats), `sendsPerHour` (how
many), `--allow-any-file` (which files).

## MCP

1. **A tool is named `<tool>_<resource>_<verb>`** after its command: `max_store_export`,
   `tg_chats_list`; a bot's, `<tool>_bot_<resource>_<verb>`: `tg_bot_messages_send`. A tool with no command (`<tool>_status`) is named after what it answers. `<tool>_conversations_refresh` runs what
   `conversations search --refresh` runs before it searches (NEED-551 A).
2. **Arguments are the command's options in snake_case**, with the option's name: `--send-id` is
   `send_id`, `--since-time` is `since_time`, `--before-n` is `before_n`.
3. **Every tool that only reads says `readOnlyHint: true`**; every tool that writes says what it
   destroys with `destructiveHint`.
4. **A tool is offered by its command's [permission](#permissions)**, never by a flag of its own:
   `deny` hides it, `readonly` hides the writing ones, `ask` shows the owner a form before it acts
   unless `mcp` was started with the command's skip flag, `allow` acts. `--confirm-send`
   puts every write through the form, whatever its level. `--allow-send`, `--allow-mark-read` and
   `--allow-delete` decide nothing any more: they are accepted with a warning, so an agent set up
   with them still starts, and go in a later release.
5. **Unknown arguments are refused before execution.** A retired schedule field must never turn
   a scheduled write into an immediate one. Consumers retaining their own session use the public
   personal MCP catalogue and registration seam, filtering only unsupported capabilities.
6. **A tool and its command run the same service method**, so they answer the same result and the
   same error for the same input.

## Help text

`<cli> commands messages search --json` describes one command; `<cli> commands messages --json`
includes the group's descendants. Give one command path per call; inspect different groups in
separate calls. Scoped discovery keeps `globalOptions` and `exitCodes`, adds
the canonical `scope` path, and lists options from non-root ancestors in `inheritedOptions`
as `{ path, options }` entries. Aliases resolve to canonical command names. Unknown or hidden
paths return `validation_error` (exit 2), with the valid commands at that level. The full tree
remains available through `<cli> commands --json`, with no scoped fields.

1. **A description says what the command does, as the user sees it**, in one line, lower case, no
   full stop, no internal term — no wire field, no port, no adapter.
2. **A shared command has the same sentence in both tools.** It is one command; the shared factory
   writes the description, and a CLI changes it only to name its messenger.
3. **An option's description says what it changes and its unit**: `--pause <duration>` "wait this
   long between pages".
4. **A shared option has one sentence in both tools**, checked by the parity workflow
   (`cli-messaging-parity wording <max.json> <tg.json>`; each file is known by its `cli`, so it takes
   any number, in any order). A difference is allowed only where the sentence names something the messenger's own way — how to name a chat, which rights or events it
   has — and the option's catalogue `note` says so; a note also marks a difference still open, and
   names who closes it.

## Layers and sharing

1. **Shared by default.** Code goes here unless it names a messenger. A feature one messenger has
   and the other could have (topics, polls) is still a port group and a shared command; it is
   CLI-local only when the other messenger cannot have it — MAX's socket server, Telegram's app
   registration.
2. **Layers:** command or MCP tool → service → port group → adapter. A command never calls an
   adapter method directly for a use case a service owns ([ARCHITECTURE](ARCHITECTURE.md#services)).
   A new adapter method goes into a named group in `port.ts`, never the core.
3. **No messenger type above the adapter.** Here, `biome.json` refuses the import; in a CLI, the
   adapter translates into the domain model and nothing above it imports the messenger library.
4. **A CLI replaces a use case, not a command** — through `Messenger.services`, so its command and
   its MCP tool both get the replacement.

## Documents

1. **Each user page of max has a tg page on the same question**, at the same depth: installing,
   using, configuring, security, troubleshooting, diagnostics, groups. max's pages are Russian,
   tg's English.
   Both follow the docs site's page set (leemour/cli-docs `docs/STRUCTURE.md`): `index.md` is the
   site's short start page, `archive.md` the local store, `roadmap.md` what is coming. Pages one tool
   has alone, and why:
   - max `bot.md` — tg has no bot side yet; its page comes with it (P8).
   max's reverse-engineered protocol is `docs/dev/protocol.md`, a developer page, not a user one.
2. **The README is the full introduction, and max's is the model.** Users read it first, so it is
   not cut down to a landing page. Both READMEs have these sections in this order: the bot, the
   personal account, how to use it, groups you run, how it works, what it can do, why it is good,
   custom work, how it differs, contents, install, log in, use, for scripts and agents, security,
   documentation, development, roadmap, licence, contributing.
3. **A change to a command changes its page in both tools** in the same docs pull request.
4. **A page names only options that exist or are planned.** Each CLI's CI runs
   `<cli> commands --json | cli-messaging-parity <cli> --pages README.md docs/*.md`: an option a user
   page puts on a command must be on that command, or be in this manifest for it and not only for the
   other tool. A change that drops an option fails until its pages stop naming it.

## The parity manifest

`parity.json`, shipped in this package, lists every command path and option of every tool. Its
`clis` names them (`["max", "tg"]`). Each CLI's CI checks its own `commands --json` against its
column of the manifest in the version of this package it installed (`pnpm parity:check`).

Each row says which CLIs have it:

```json
"messages list": { "in": "all" },
"polls":         { "in": ["max"], "reason": "Telegram polls are …" },
"store clear":   { "in": ["tg"], "planned": { "max": "T6" } }
```

| Field | Meaning | What `parity:check` checks for a CLI |
|---|---|---|
| `in` | `"all"`, or the CLIs from `clis` that have it | listed: present in this tool |
| `planned` | a CLI outside `in` → who closes the gap (a workstream) | planned: nothing — present or absent both pass |
| `reason` | why the CLIs neither in `in` nor planned lack it; required when there are any | neither: absent in this tool |

An option is the same object, or the bare string `"all"`. A row only one CLI has, with a `reason`,
covers every path below it. A row with `"subtree": true` and a plan does the same, for a whole
command tree a tool has yet to build: `bot` is one row.

**A new CLI joins with one command:** `pnpm parity:seed --cli <name>` adds it to `clis` and plans
every row and option for it, by `"?"`. Its parity check passes from its first pull request, and the
gaps stay listed. Its author then narrows the rows:
moves the CLI into `in` where it has the command, names who closes each plan, and gives a reason where
it never will. `pnpm parity:seed <commands.json...>`, one file per CLI, adds the rows the CLIs have
and the manifest lacks; a row already there is never changed.

**How a new command or option reaches CI without a release of this package per row.** The docs
pull request that introduces it adds its row as planned, here, before any code. Planned passes
whether the command exists or not, so the code pull request in any CLI lands on the manifest
already released. The flip to `in` goes into the next release of this package with whatever else
it carries; a row is never the only reason for a release.

**A row puts a CLI in `in` only when that tool has it on its own `main`.** A shared command that one
CLI does not use yet — max keeps its own `messages edit` until it moves onto the shared one — stays
planned for it, by the workstream that moves it. So does an option a CLI still has and is about to
drop. Flipped early, the row fails that CLI's `parity:check` on its next upgrade of this package and
blocks the upgrade.

**This repository checks every tool's `main` against its own manifest** (`.github/workflows/parity.yml`):
on a pull request that touches the manifest or the check, on every push to `main`, and daily. It
builds tg-cli and max-cli from their `main` and runs the same check, so a row flipped early fails
here, before the release that would carry it — not weeks later, when a CLI upgrades. The published
CLIs are not the reference: a release always trails `main`, so they lag every row that gains a CLI.
A new CLI is added to the workflow's matrix and its wording job when its repository exists.

**The milestone audit is one command:** `pnpm parity:audit --fresh` clones and builds every tool's
`main` and prints, besides the manifest's state, what CI does not fail on: the shared version each
tool pins, the MCP tools each offers, the user pages and their headings, the README sections, and the
release and QA scripts and skills. Each MCP server starts in an empty temporary home, so nothing
reaches Telegram or MAX. `--max <dir> --tg <dir>`, one option per CLI in `clis`, uses checkouts already
built.
