# tg parity with max-cli and tgcli — work in parallel lanes

2026-09-29. The owner wants tg-cli **quickly** at the level of max-cli (0.19.0) and covering what
[kfastov/tgcli](https://github.com/kfastov/tgcli) (2.2.3) has, with the work run in parallel. This
file is the plan for that thread of work; the backlog stays [the proposal's §8](2026-09-26-platform-proposal.md#8-phases--small-independently-shippable-pull-requests),
which links here.


**Correction 2026-09-30:** the open part of this plan continues as the parity plan (max-cli's
private `docs_ai/plans/2026-09-30-parity-plan.md`, handoffs in `docs_ai/plans/parity/`): P0 one
standard (`docs/dev/STANDARD.md`) and a parity manifest checked in both CLIs' CI; P1 options on the
shared commands; P2 administration built shared here (replaces lane L6); P4 tg's documents; P5 tg's
release checks. Every PR is reviewed against `docs/dev/REVIEW.md`, and a change starts with its docs.
**B1c completed (2026-10-03):** shared personal `messages link` service/CLI/MCP (#483, published 0.139.0), Telegram permalink capability (tg#252), MAX validated locator fallback (max#381). No store migration.

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
| **L2 · acting on messages** — done 2026-09-30 (cli-messaging 0.50.0, tg 0.14.0) | `messages edit` · `messages delete` (`--for-everyone`, MCP `--allow-delete`) · `messages forward` · `messages pin\|unpin` · `reactions add\|remove` · `chats mark-read` (MCP `--allow-mark-read`) · polls `vote\|create\|close` | max |
| **L3 · richer sending** | `messages send --file\|--photo\|--voice\|--video` · `--silent` · `--md` / parse mode · `--no-preview` · `--at` + `messages scheduled` · `--topic` · album | max, tgcli |
| **L4 · media** — done 2026-09-30 (cli-messaging 0.53.0, tg 0.17.0) | `messages download` (one message, and `--all` for a chat) · the MCP photo tool (image content, ≤ 512 KB) · voice to text — **NEED-20** | max, tgcli |
| **L5 · archive and service** | `serve` as an OS service (`service install\|start\|stop\|status\|logs`, systemd and launchd) · fetch jobs (`store fetch --background`, `store jobs list\|show\|cancel`) · `store export --format markdown` · `store fetch --estimate` · `messages search --regex` · `doctor report` · `cache clear` · `session start --qr-file` | tgcli, max |
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

**Store migrations are announced here before they are written.** The next free number is **28**
(27 is owner-wide labels — `owner_targets`, so tags on a person, entity, task or notes folder need no account, with the copy of existing account-scoped ones — `feat/notes-api-gaps`, [`2026-10-08-notes-graph.md`](2026-10-08-notes-graph.md), announced 2026-10-08; 26 is search indexes for notes — `note_words` and `note_stems` (full-text words and stems of each note), `note_chunks` for vectors, and the notes' row in `search_index_state` — `feat/notes-index`, [`2026-10-08-notes-graph.md`](2026-10-08-notes-graph.md) §3.6, announced 2026-10-08; 25 is notes as their own records — `note_folders`, `notes`, `note_revisions`, `links`, the `note` tag target, owner-scoped entities and the copy from annotations, relations and notes-provider messages, plus the notes word and stem indexes — `feat/notes-graph`, [`2026-10-08-notes-graph.md`](2026-10-08-notes-graph.md), announced 2026-10-08; 24 is membership observation batches and per-message counter observations for retention/freshness — `feat/retention-freshness`, announced 2026-10-08; 23 is Memo cross-source annotations/labels, manual entity relationships and durable local reminders — `feat/memo-shared-backlog-20261008`, announced 2026-10-08; 22 is account-scoped private contact aliases/annotations, channel metadata snapshots and automatic tag provenance — `feat/private-people-metadata`, announced 2026-10-07; 21 is long-message chunks — `conversation_chunks.text_start` and `text_end`, the stretch of one long message a chunk holds, so a message longer than a chunk is split for embedding instead of cut at the model's limit; cli-memo's notes and mail need it; max-cli-private's plan `plans/2026-10-06-cli-memo-auto-import.md` part 3, announced 2026-10-06; 20 is open tasks — `tasks`, the storage behind `@leemour/cli-tasks`, max-cli's plan `plans/2026-10-04-group-monitoring-tasks.md`, announced 2026-10-05; 19 is file content search — text read from attachments and the agents' write-back, `attachment_texts` and its word index `attachment_words`, max-cli's plan `plans/2026-10-04-file-content-search.md`, announced 2026-10-05; 18 is member history — who was in each tracked group and when, daily member counts and profile changes: `member_stays`, `member_counts`, `identity_revisions`, max-cli's plan `plans/2026-10-04-member-history.md`, announced 2026-10-04; 17 is the saved searches and their run history, `searches`, and 16 is polymorphic tags, `tags` — max-cli's plan for saved queries and tags, announced 2026-10-04, **merged only after 15 is on `main`** and in that order; 15 is Snowball stemming's stem index — `message_stems`, its pending queue, `search_index_state.analyzer` and `store_settings`, [`2026-10-04-stemmed-search.md`](2026-10-04-stemmed-search.md) S1, announced 2026-10-04; 14 is phase 5's chunks and vectors — [`../storage/plans/phase-5.md`](../storage/plans/phase-5.md) E8, announced 2026-10-02; it was first taken for `chats.left_at` on 2026-10-01 and released the same day: version 6's
`membership_state` already holds `left`, [`../storage/plans/chats-left.md`](../storage/plans/chats-left.md); 13 is phase 3's conversation tables — [`../storage/plans/phase-3.md`](../storage/plans/phase-3.md) item 1,
announced 2026-10-01, **merged only after 12 is on `main`**: the runner skips every version at or below the
file's, so a file already at 13 would never get 12 (`src/store/migrations.ts:314`); 12 is phase 2's word index — [`../storage/plans/phase-2.md`](../storage/plans/phase-2.md) item 1,
announced 2026-10-01; 7–11 are the tables max-cli's personal data needs — chat members, sync state, fetch leases, contact
recency, transcripts — [`../storage/plans/phase-1-max-tables.md`](../storage/plans/phase-1-max-tables.md),
announced 2026-09-30; 6 is the storage work's phase 1 — Drizzle and the forced upgrade, released in
0.49.0, [`../storage/plans/phase-1.md`](../storage/plans/phase-1.md), announced 2026-09-29; 4 is `account_identities`, cli-messaging #48; 5 is message text back to trigram, #55 — taken
without an announcement first, corrected here; both 2026-09-29). Take it by editing this line in a PR of
its own, merged before the migration. L7 is the likely next taker; chat members are in 7.

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

MAX P7 follow-up: `fix/p7-unpin-parity` owns the legacy pin/unpin permission translation and shared unpin guard correction; no database migration.

Server search (2026-10-07): [`2026-10-07-server-search.md`](2026-10-07-server-search.md) owns `--backend archive|server|both`, the optional `MessageSearch` adapter capability and `src/services/server-search.ts`; no store migration.

L7 private people metadata (2026-10-07): `feat/private-people-metadata` owns account-scoped aliases and annotations, cached channel metadata and deterministic auto tagging for both tg and MAX. Migration 22 is reserved before implementation.
