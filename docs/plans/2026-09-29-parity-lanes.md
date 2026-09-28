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
| **L0 · foundation** — first, alone, one day | make parallel work cheap: §3 | — |
| **L1 · reading** | `review` + its prompt (`--chat`, `--unanswered`) · `chats list --search --kind --unread` · `messages list --after` · `chats events` · `chats members list` · `contacts lookup` (phone from stdin) · `contacts sync` · `account sessions list` · `chats inspect <link>` · `topics list\|search` (forums) | max, tgcli |
| **L2 · acting on messages** | `messages edit` · `messages delete` (`--for-everyone`, MCP `--allow-delete`) · `messages forward` · `messages pin\|unpin` · `reactions add\|remove` · `chats read` (MCP `--allow-mark-read`) · polls `vote\|create\|close` | max |
| **L3 · richer sending** | `messages send --file\|--photo\|--voice\|--video` · `--silent` · `--md` / parse mode · `--no-preview` · `--at` + `messages scheduled` · `--topic` · album | max, tgcli |
| **L4 · media** | `messages download` (one message; `--all` for a chat later) · the MCP photo tool (image content, ≤ 512 KB) · voice to text — **NEED-20** | max, tgcli |
| **L5 · archive and service** | `serve` as an OS service (`service install\|start\|stop\|status\|logs`, systemd and launchd) · backfill jobs (`--background`, `backfill status\|list\|cancel`) · `export --format markdown` · `backfill --estimate` · `messages search --regex` · `doctor report` · `cache clear` · `session start --qr-file` | tgcli, max |
| **L6 · administering** (P3) | `chats create\|update\|leave\|join` · `chats members add\|remove` · `chats admins` · `chats link show\|reset` · `chats folders …` · `contacts add\|remove\|block\|unblock\|rename\|import` · `account update` · `account sessions end-others` · `chats rules` + `chats check` | max, tgcli |
| **L7 · CRM on the store** (Phase 4 start) | local tags, aliases and notes on chats and people (`msg` reads them) — tgcli has them per account; ours go in the shared store, a migration each | tgcli |

Out: `bot *` (a user account is not a bot); tgcli's `feedback` (sends from the owner's account to a
stranger); tgcli's HTTP MCP without a token.

## 3. L0 — what makes parallel lanes cheap

Six files would take a change from every lane and conflict on every merge. L0 fixes that once:

1. **`MessengerAdapter` gets optional methods** (`edit?`, `forward?`, `react?` …) instead of
   required ones, and a command whose method is missing refuses with `validation_error` ("this
   messenger cannot …"). Then a lane adds a method without touching the five test fakes in tg
   (`src/program.test.ts`, `runs.test.ts`, `send-guard.test.ts`, `offline.test.ts`,
   `contract.test.ts`), and max can implement what it has.
2. **`commands.ts` (484 lines) splits into one file per resource** — `chats-command.ts`,
   `messages-command.ts`, `contacts-command.ts` — and a new resource is a new file.
3. **`mcp/tools.ts` becomes `mcp/tools/<resource>.ts`**, each exporting its tools; the registry
   only spreads them.
4. **tg's adapter gets one file per area** behind the class (`telegram/messages.ts`,
   `telegram/chats.ts` …), so two lanes do not edit the same method list.
5. **One shared fake adapter for tg's tests** (`src/testing/fake-adapter.ts`) replaces the five copies.
6. **The release train (§4).**

## 4. Releases while lanes run

Parallel lanes that each bump the version collide (0.10.0 and 0.13.0 did). So: **a lane merges
without a bump, and never releases.** The coordinating session releases cli-messaging and then tg
when a lane has landed something usable — at most a few times a day — after `git fetch` and
`npm view`. Before a release, a lane that needs an unreleased cli-messaging tests tg against a packed
tarball (`pnpm pack`), never a committed `file:` path.

Store migrations are the one thing lanes must not do blind: migration numbers are announced here
before they are written (next is **4**). L1 `chats events` and L7 are the likely takers.

## 5. How a lane runs

- One session per lane, each in its own **git worktree** of both repositories:
  `../cli-messaging-wt-<lane>` and `../tg-cli-wt-<lane>`, branch `feat/<lane>-<command>`.
- Each lane starts from [the tg handoff](../../../tg-cli/HANDOFF.md) §3c (the path a new adapter
  method takes) and copies max-cli's command and tool (`../max-cli/src/commands/`, `src/mcp/tools.ts`,
  `docs/`), adjusting for Telegram.
- Live checks: read-only through `bin/tg` of its own worktree; a send only to Saved Messages, and
  only in L2/L3. Each worktree needs its own `bin/tg session start` — ask the owner, never copy `.tg/`.
- A lane finishing a PR: rebase-merge when green (the owner's rule), then the next item.
- Conflicts left after L0 — `README.md`, `docs/mcp.md`, `SKILL.md`, the proposal — are append-only
  lists; rebase and keep both.

## 6. Decisions

Already ruled this week: the MCP server may send, as max-cli's does (NEED-15 → B); aim at parity
with max-cli and cover tgcli (NEED-15, 2026-09-29); `inbox` and `review` open tier P1 (NEED-18 → A).


- **NEED-19** — whether `inbox` leaves out muted and archived chats (measured: 88 of the newest 100
  chats have unread, 3.3 million unread in groups, none in one-to-one chats).
- **NEED-20** — voice to text: Telegram's own transcription (Premium), max-cli's local model, or later.
- **NEED-21** — how many lanes at once.
