# tg parity with max-cli and tgcli — work in parallel lanes

2026-09-29. The owner wants tg-cli **quickly** at the level of max-cli (0.19.0) and covering what
[kfastov/tgcli](https://github.com/kfastov/tgcli) (2.2.3) has, with the work run in parallel. This
file is the plan for that thread of work; the backlog stays [the proposal's §8](2026-09-26-platform-proposal.md#8-phases--small-independently-shippable-pull-requests),
which links here.

## 1. Where things stand

- **Done:** Phases 1–3 (reading, the store and search, MCP with `--allow-send`/`--confirm-send`,
  prompts, resources, the skill) and `inbox` — tg 0.3.0, cli-messaging 0.25.0.
- **max-cli moved on** since the gap was measured (0.17.1 → 0.19.0, 76 commits): moderation
  (`chats events|members|rules|check`), `review --chat --unanswered`, polls, voice to text, sending
  video and voice, profile and contact changes, `--limit` and `hasMore` everywhere, bot accounts.
- **One database for every profile is already how tg works**: every profile and every messenger
  writes the one shared store, keyed by provider and account. In max-cli only bots write it; its
  personal account still has a database per profile, and no max-cli branch or backlog item moves it
  yet. Moving max onto the shared store stays Phase 4, under max-cli's rules (NEED-2).
- **tgcli** is an archiver first: a background daemon the CLI talks to, backfill jobs with status,
  systemd/launchd installers, files and photos and scheduled sends, forum topics, folders, local tags
  and notes on chats and contacts, regex search. Its safety is thin — MCP over HTTP with no token,
  sends at once, no read-only mode — which is where tg already leads.

## 2. The lanes

Each lane is a sequence of small PRs; each PR adds a command **and its MCP tool together**, in
cli-messaging (shared) and tg (adapter), with tests, README, `docs/mcp.md` and the skill. Lanes run
at the same time; the order inside a lane is the order below.

| Lane | What | Source |
|---|---|---|
| **L0 · foundation** — done 2026-09-29 | made parallel work cheap: §3 | — |
| **L1 · reading** | `review` + its prompt (`--chat`, `--unanswered`) · `chats list --search --kind --unread` · `messages list --after` · `chats events` · `chats members list` · `contacts lookup` (phone from stdin) · `contacts sync` · `account sessions list` · `chats inspect <link>` · `topics list\|search` (forums) | max, tgcli |
| **L2 · acting on messages** — done 2026-09-30 (cli-messaging 0.50.0, tg 0.14.0) | `messages edit` · `messages delete` (`--for-everyone`, MCP `--allow-delete`) · `messages forward` · `messages pin\|unpin` · `reactions add\|remove` · `chats read` (MCP `--allow-mark-read`) · polls `vote\|create\|close` | max |
| **L3 · richer sending** | `messages send --file\|--photo\|--voice\|--video` · `--silent` · `--md` / parse mode · `--no-preview` · `--at` + `messages scheduled` · `--topic` · album | max, tgcli |
| **L4 · media** — done 2026-09-30 (cli-messaging 0.53.0, tg 0.17.0) | `messages download` (one message, and `--all` for a chat) · the MCP photo tool (image content, ≤ 512 KB) · voice to text — **NEED-20** | max, tgcli |
| **L5 · archive and service** | `serve` as an OS service (`service install\|start\|stop\|status\|logs`, systemd and launchd) · backfill jobs (`--background`, `backfill status\|list\|cancel`) · `export --format markdown` · `backfill --estimate` · `messages search --regex` · `doctor report` · `cache clear` · `session start --qr-file` | tgcli, max |
| **L6 · administering** (P3) | `chats create\|update\|leave\|join` · `chats members add\|remove` · `chats admins` · `chats link show\|reset` · `chats folders …` · `contacts add\|remove\|block\|unblock\|rename\|import` · `account update` · `account sessions end-others` · `chats rules` + `chats check` | max, tgcli |
| **L7 · CRM on the store** (Phase 4 start) | local tags, aliases and notes on chats and people (`msg` reads them) — tgcli has them per account; ours go in the shared store, a migration each | tgcli |

Out: `bot *` (a user account is not a bot); tgcli's `feedback` (sends from the owner's account to a
stranger); tgcli's HTTP MCP without a token.

## 3. L0 — what makes parallel lanes cheap — **done 2026-09-29**

The files every lane would have edited were split or taught to need no edit (cli-messaging 0.27.0,
[#52](https://github.com/leemour/cli-messaging/pull/52)):

1. `cli/messenger/commands.ts` is one file per resource (`chats-command.ts`, `messages-command.ts` …).
2. `mcp/tools.ts` is `mcp/tool.ts` plus `mcp/tools/<resource>.ts`.
3. A new `MessengerAdapter` method is optional and reached with `capability()`; `observed` and
   `stored` pass through any method they do not list (`throughWrapper`), so the five test fakes in
   tg and the two wrappers need no edit per method.
4. Worktrees and permissions for agents: tg-cli [`docs/dev/agents.md`](https://github.com/leemour/tg-cli/blob/main/docs/dev/agents.md)
   (`bin/lane`, `bin/agent`, `bin/try-messaging`, the write hook).

Left out as not worth it now: splitting tg's `adapter.ts` per area and one shared test fake — with
optional methods, lanes no longer edit the fakes, and two groups of methods at the end of one class
rebase cleanly.

## 4. Releases while lanes run

**Each lane releases its own merged work** (NEED-10 → C, unchanged): `git fetch`, `npm view`, a
`chore: release` PR raising the version from what is really published, `bin/release`. Two lanes
racing is safe: `bin/release` refuses a version already on npm, and the second rebases, renumbers
and retries. To try an unreleased cli-messaging in tg first: `bin/try-messaging` in the lane's tg
worktree, never a committed `file:` path.

**Store migrations are announced here before they are written.** The next free number is **7**
(6 is the storage work's phase 1 — Drizzle and the forced upgrade, [`../storage/plans/phase-1.md`](../storage/plans/phase-1.md),
announced 2026-09-29; 4 is `account_identities`, cli-messaging #48; 5 is message text back to trigram, #55 — taken
without an announcement first, corrected here; both 2026-09-29). Take it by editing this line in a PR of
its own, merged before the migration. L1 `chats events` or members, and L7, are the likely takers.

**Services are coming to the command files (2026-09-30, [`2026-09-30-services.md`](2026-09-30-services.md)).**
Commands and MCP tools stop calling the adapter and the store directly and call `services.*`
instead, one group per PR: message reads, message writes, chats and people, inbox and sync. A lane
that adds a subcommand in a group already moved adds a service method and calls it; one in a group
not yet moved writes it as today, and the services PR moves it. Each services PR is rebased on the
lanes' merges, never the other way round.

## 5. How a lane runs

tg-cli [`docs/dev/agents.md`](https://github.com/leemour/tg-cli/blob/main/docs/dev/agents.md): `bin/lane <lane>` makes the lane's
worktrees of both repositories under tg-cli's `.worktrees/` and copies the owner's login in;
`bin/agent <lane>` starts Claude Code there without prompts. Each lane reads its own handoff
(standard: tg-cli [`docs/dev/handoff-standard.md`](https://github.com/leemour/tg-cli/blob/main/docs/dev/handoff-standard.md)):

| Lane | Handoff |
|---|---|
| L1 · reading | [`docs/lanes/l1-reading.md`](https://github.com/leemour/tg-cli/blob/main/docs/lanes/l1-reading.md) |
| L2 · acting on messages | [`docs/lanes/l2-actions.md`](https://github.com/leemour/tg-cli/blob/main/docs/lanes/l2-actions.md) |
| L3 · richer sending | [`docs/lanes/l3-sending.md`](https://github.com/leemour/tg-cli/blob/main/docs/lanes/l3-sending.md) |

L4–L7 get theirs when one of the first three finishes (NEED-21: three at once).

## 6. Decisions

Ruled: the MCP server may send, as max-cli's (NEED-15 → B); parity with max-cli and tgcli
(NEED-15); `inbox` and `review` open the reading lane (NEED-18 → A); `inbox` leaves out muted and
archived chats unless they mention or answer the owner, `--all` for everything (NEED-19 → A, L1's
first item); voice to text uses Telegram's own transcription when the account has Premium and the
local model otherwise, **configurable** (NEED-20 → A, L4); three lanes at once, after a foundation
that is solid but small (NEED-21, 2026-09-29).

Open: whether agents' shell commands run in the sandbox, which needs a root change on the owner's
machine (NEED-22, tg-cli `docs/dev/agents.md`).
