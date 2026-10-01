# Phase 3 — conversations inside a group chat

Plan, 2026-09-30. **Approved by the owner 2026-09-30** (NEED-420 A). Nothing is built yet. It follows
[`../decisions.md`](../decisions.md), in particular the ruling of 2026-09-30 that the CLI never calls an
AI model to link messages and the user's own agent does it (phase 4). Requirements §12, §13 stages 1–2,
§16 and §28 are the brief; §13 stage 3, §14, §15 and §27 are replaced by that ruling.

Evidence labels as in the rest of this folder: **verified** has a `path:line` or a command, **docs say**
or **paper** names the source, **inferred** is reasoning.

## 1. Goal

At the end of phase 3, for a chat the user asks for:

- every message has **at most one parent** — the earlier message it answers — or starts a new
  conversation, and the store says **where each link came from**: the messenger, or a rule;
- **conversations** are the groups those links form, readable as a transcript, oldest first;
- **why two messages are together** is one command away;
- the rules are **scored** on public labelled data, and a rule that does not beat the simplest baseline
  is not shipped;
- the tables already accept the links the agent will write in phase 4.

No AI, no embeddings, no network. Conversation context in search results waits for phase 2's search.

## 2. Depends on

- **Phase 1** — the async store, Drizzle, `messages.pk`. Nothing else.
- **A migration number**, the next free one, announced in
  [`../../plans/2026-09-29-parity-lanes.md`](../../plans/2026-09-29-parity-lanes.md) before it is written.
  7–9 are proposed by the max-cli tables plan (#152); tg-cli lanes take numbers too.
- **The services layer** ([`../../plans/2026-09-30-services.md`](../../plans/2026-09-30-services.md)):
  the new commands call a `conversations` service, not the store.

## 3. What we know

**The store keeps what phase 3 needs, except mentions** (verified, `src/store/migrations.ts`):
`reply_to_native_id` `:112`, `thread_native_id` `:104`, `sender_identity_pk` `:105`, `sent_at`,
`deleted_at` `:110`, `message_revisions` `:127`, and `identities.username` for `@handle` lookups.
Mentions of a person are not stored: tg-cli reads message entities only to send formatting
(tg-cli `src/telegram/map.ts:312-323`), and what a mention looks like in MAX's user protocol is
unknown — the one capture we have holds only the setting `mentions-enabled`.

**Replies give pairs, not conversations** (measured 2026-09-30 on a development copy of a Telegram
archive, numbers only):

| | large public group | small group |
|---|---|---|
| messages / senders | 5,000 / 1,317 | 270 / 24 |
| in a reply link | 60.5% | 35.2% |
| reply groups: median / largest | 2 / 18 | 2 / 6 |
| no link at all | 40% | 65% |
| next message by the same sender | 11.2% | 29.0% |
| reply parent within 50 / 100 messages back | 96.7% / 97.7% | 100% / 100% |
| reply parent, p50 / p90 / p95 in time | 8 min / 10 h / 34 h | 3 min / 5 h / 52 h |

The history is a sample, so distances in messages may be understated. The time tail is long, so a
window by time does not work; a window by message count does.

**From the literature** ([`../research/2026-09-30-disentanglement.md`](../research/2026-09-30-disentanglement.md)):

- The labelled IRC corpus (Kummerfeld et al., ACL 2019; data CC BY 4.0, code ISC) marks **each message's
  parent**, a message pointing at itself starts a conversation, and conversations are the union of those
  links (`graph-to-cluster.py`). Its scorers take that format. **paper**, **code**
- On its test set the rule "each message answers the one before" scores link F1 35 and conversation
  exact-match F1 0; the trained model 72.3 and 36.2; two humans agree on 49.5. **paper**
- A person takes part in about 3.3 conversations at once, and "a sender's messages are one conversation"
  held 52% of the time — a same-sender link is a guess, not a fact. **paper**
- Naming the addressee is the strongest single feature. **paper**

**The archive research** ([`../research/2026-09-30-archive-reliability.md`](../research/2026-09-30-archive-reliability.md))
adds nothing that blocks this phase.

## 4. Decisions made here

**C1 · One parent per message for conversations; several links per message in storage.**
`message_links` may hold several candidate links for a message — a reply, a rule's guess, later the
agent's answer. The **chosen** parent is one of them, picked by source order: messenger, then agent,
then rule, and within a source the highest confidence. Conversations are the groups the chosen parents
form. Why: grouping over every link above a threshold chains conversations together in a busy group —
one weak link joins two of them. One chosen parent gives separate trees, and matches the IRC format
and its scorers. A message answering two others (the brief's "Dave agrees with Bob and Carol") keeps
both links; the transcript uses one.

**C2 · Tables.** Names final at review. `pk`s are store keys, never provider ids.

```text
message_links
  message_pk     the later message
  parent_pk      the earlier message it answers; NULL = "starts a conversation"
  source         provider | rule | agent
  kind           reply | thread | same_sender | mention | …   (what the source saw)
  confidence     0..1; provider links are 1
  method         rule name, or the agent's model
  version        algorithm or prompt version
  batch          phase 4: which batch wrote it; NULL otherwise
  created_at
  stale_at       set when either end changed after created_at (C4)
  UNIQUE (message_pk, parent_pk, source, kind)

conversations
  pk, chat_pk, first_message_pk, first_at, last_at, message_count, built_at, algorithm_version

conversation_messages
  conversation_pk, message_pk            UNIQUE (message_pk)

conversation_state
  chat_pk, enabled_at, built_at, algorithm_version
```

All four are derived: dropping them never touches `messages` (requirements §29.3, §29.5).

**Added 2026-10-01, at build (store version 13):** every foreign key of the four tables is `ON DELETE
CASCADE`. A build that knows nothing of these tables purges an account by deleting its messages and
chats; with the foreign keys enforced, that delete would otherwise fail once a link points at one of
them. "Starts a conversation" (`parent_pk` `NULL`) has its own partial unique index, since a `UNIQUE`
constraint treats `NULL`s as distinct.

**Correction 2026-10-01 to C3 (owner, NEED-475 A):** a chat is not replaced in one transaction. At 1M
messages that held the write lock for 14–16 s, and every other process waits 5 s
([`bench/disentangle/`](../../../bench/disentangle/README.md)). Each rebuild gets a **build number**:
its links and conversations are written in short transactions under that number, one short transaction
makes it `conversation_state.current_build`, and the older builds are then deleted in batches. Readers
see only the current build, so a failed build still leaves the previous one intact. `build` is on
`conversations` and `message_links` (`NULL` for the agent's links); one unique index covers every link,
with `ifnull` for the missing parent and build.

**C3 · Rebuild the whole chat every time, in phase 3.** A rebuild deletes the chat's `provider` and
`rule` links and its conversations, recomputes them from `messages`, and stamps the time the build
**started**. No watermark and no dirty regions. Why: for the largest chat we hold (5,000 messages) this
is milliseconds (inferred; item 7 measures it), and a watermark misses real changes — the save path
fills in a missing `reply_to_native_id` on an old row with `coalesce` (`src/store/store.ts:338`, `:372-380`),
which leaves no new insert time, revision or deletion behind. Region rebuilds come later, only when
a large chat measures slow.

**C4 · Agent links survive a rebuild.** Provider and rule links are cheap to recompute; agent links
(phase 4) are not. A rebuild keeps `source = 'agent'` rows, keyed on `message_pk`, and sets `stale_at`
on one whose message or parent was edited (a `message_revisions.captured_at` after its `created_at`) or
deleted after it was written. A stale link is not chosen; phase 4 asks the agent again.

**C5 · The rules, v1.** Each writes candidate links; none is a merge.

| rule | link | confidence |
|---|---|---|
| reply | `reply_to_native_id` → that message, when held | 1 (source `provider`) |
| thread | never choose a parent in another forum thread | a boundary, not a link |
| mention | `@handle` in the text → that person's latest message in the previous 50 | 0.8 (starting value) |
| same sender | the sender's own previous message, when it is among the previous 10 and under 5 minutes old (tuned 2026-09-30, `bench/disentangle/sweep.ts`) | 0.5 — below mention, which measured better at every setting |
| none of the above | no parent: the message starts a conversation | — |

`@handle` is read from the text at build time, so it works on history already downloaded, for both
messengers. A mention of a person without a handle needs the adapters to keep mention entities: a
nullable `mentions` column (their ids), filled by tg-cli from message entities, and by max-cli once a
capture shows MAX's shape. That is item 3, and it is optional for the rest.

Starting values are placeholders; item 6 sets them from the scores. A rule that does not beat the
"previous message" baseline on the IRC test set, and does not add correct links on the held-out
replies (item 6), is dropped.

**C6 · Only chats the user enables.** `conversations build --chat X` enables and builds; nothing builds on
sync (requirements §22). `conversation_state` says which chats are enabled and how fresh they are.

**C7 · Commands** (owner, NEED-421 A):

**Correction 2026-10-01, at build:** no `--rebuild` — every build replaces the chat's last one (C3), so
the flag had nothing to switch. `list` takes `--since-time` and `--limit`, options that already mean that
everywhere, not `--after`/`--before`. `show` takes a conversation id, or `<chat> <message>`. The MCP tools
are `conversations_list` and `conversations_show`, after their commands, as every tool here.

- `conversations build --chat <chat> [--rebuild]` — the rules, then the grouping; prints counts.
- `conversations list --chat <chat> [--after] [--before]` — one line each: first message, size, people, span.
- `conversations show <conversation | message>` — the transcript, oldest first; a message's own
  conversation when given a message.
- `messages links <message>` — every link of a message and its parent chain: source, kind, confidence,
  method, whether chosen. This is "why are these together" (brief: inspectability).
- MCP: `conversations_list`, `conversation_show`; read-only.

Example, invented:

```text
$ tg conversations show 91
Valencia Expats · 12 May 10:01–10:05 · 4 messages · Alice, Carol

10:01 Alice   Anyone know a good dentist?
10:02 Carol   ↳ @Alice yes, Clínica X            mention
10:03 Alice   ↳ thanks, where is it?             reply
10:05 Carol   ↳ Ruzafa                           reply
```

## 5. Work items

1. **Migration**: the four tables of C2, number announced first. Drizzle schema plus a hand-checked SQL
   file; no rebuild of an existing table.
2. **Correction 2026-10-01, at build:** built as `linkInputs`, `senderHandles`, `replaceConversations`, `conversations`, `conversation`, `conversationOf`, `links`, `conversationState`; `saveLinks` waits for phase 4, the only writer of agent links. · **Store methods**: `saveLinks`, `links(message)`, `replaceDerived(chat, links, conversations)` in one
   transaction per chat, `conversations(chat, window)`, `conversation(pk)`; nothing Drizzle-typed crosses.
3. **Mentions** (optional): the nullable `mentions` column; tg-cli fills it from the message's
   mention entities; max-cli after a capture. Only new downloads get it.
4. ✅ 2026-09-30, `src/conversations/link.ts` (the pure function; reading the store waits for phase 1) · **The builder**: a pure function from a chat's messages (in order, streamed in batches of `pk`) to
   links and conversations. Reads by `pk` range, holds a 50-message look-back, never the whole chat in
   memory.
5. **The `conversations` service and commands** of C7, and the two MCP tools.
6. ✅ 2026-09-30, [`bench/disentangle/`](../../../bench/disentangle/README.md) · **Scoring**: `bench/disentangle/` — downloads the IRC corpus into a directory outside the repository
   (never committed), converts it to our messages, runs the builder, writes links in the IRC graph
   format, and runs the corpus's own `conversation-eval` scorers (Python, via `uv`). Also scores against
   our own replies: hide a random 20% of reply links in a local archive, rebuild, count how many the
   rules recover — numbers only, the archive never leaves the machine.
7. **Measure**: build time and memory for 5k, 100k and 1M generated messages (`bench/search`'s
   generator); if 1M takes more than a minute, plan region rebuilds.
8. **`db doctor`** reports per enabled chat: built with which version, stale agent links.

## 6. Test plan

- Builder, on invented messages: a reply chain; two interleaved conversations joined only by replies;
  a mention that picks the mentioned person's message, not the previous one; a same-sender run broken by
  a two-minute gap; a thread boundary; a reply to a message not held (starts a conversation; joins after the parent arrives and the chat is rebuilt); a deleted message.
- Choice order: a provider link beats an agent link, which beats a rule link.
- Rebuild keeps agent links and marks one stale after an edit to its parent.
- `replaceDerived` in one transaction: a failed build leaves the previous conversations intact.
- Dropping the four tables leaves every message and search result unchanged.
- Machine output: `--json` for every command, stdout only data.
- ~~Scoring script: run in CI on a 1,000-line fixture made of invented messages, not on the IRC data.~~
  **Correction 2026-09-30:** not run in CI, like `bench/search`; the rules have their own tests in
  `src/conversations/link.test.ts`, and the script is run by hand when a rule changes.

## 7. Open questions

1. ~~Names~~ — answered 2026-09-30 (NEED-421 A): `conversations build|list|show` and `messages links`.
2. ~~Same-sender links~~ — answered 2026-09-30 (NEED-422 A): a candidate, as C5, its confidence and
   threshold set by the scores of item 6; never joined automatically.
3. ~~A reply to a message we do not hold~~ — answered 2026-09-30 (NEED-423 A): it starts a new
   conversation and keeps its reply link; the next rebuild joins it once the parent is downloaded.
4. **Forum threads in MAX**: does MAX have them at all? `threadId` is filled by tg-cli only today.
5. **Mentions in MAX**: needs a capture of a message that mentions someone, before item 3 covers MAX.
6. **Telegram senders have no username in the store** (0 of 1,535 identities in a development copy,
   2026-09-30), so the mention rule cannot fire on Telegram. `Message` carries `senderName` but no
   handle, and tg-cli does not pass one; the store keeps a username once given. **Update 2026-09-30:**
   `Message.senderUsername` added and saved by the store; tg-cli fills it (owner: «it should be built
   into messaging»). Whether it helps is not measured: the held-out check (2 of 397 found) tests button replies,
   where these rules are weakest by design. See [`bench/disentangle/README.md`](../../../bench/disentangle/README.md).
