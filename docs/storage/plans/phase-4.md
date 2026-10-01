# Phase 4 — the user's own agent links messages into conversations

Plan, 2026-10-01. **Approved by the owner 2026-10-01** («prepare plan for 4 and merge»); nothing is built.
The two questions of §7 took the recommended option (A) by default — the owner asked not to be asked. It follows [`../decisions.md`](../decisions.md), the
ruling of 2026-09-30 (NEED-405): **the CLI never calls an AI model to link messages; the user's own agent
does it**, through a skill and CLI commands, only when the user asks. The CLI builds the free links
(phase 3), hands out overlapping batches with candidate links, stores the links the agent returns with
their source and model, and builds conversations from them. Requirements §13 stage 3, §14 `--mode ai`,
§15 and §27's `ConversationInferenceProvider` are replaced by that ruling; what is kept from them is
named in A-decisions below.

Evidence labels as in the rest of this folder: **verified** has a `path:line` at a named commit, **docs
say** names the source, **inferred** is reasoning. Phase 3's code is read at `8108fd6`, the tip of
`feat/conversation-check` — built, not merged yet ([phase 3](phase-3.md), cli-messaging #255).

## 1. Goal

At the end of phase 4, for a chat the user asks for:

- `conversations batches status --chat <chat>` says how many messages still need the agent, in how many
  batches, and how much text that is — the agent tells the user before it starts;
- `conversations batches next --chat <chat>` prints one batch: messages with context, and the candidate
  links the messenger and the rules found;
- `conversations links add --batch <id>` takes the agent's answer — one parent per message, or "starts a
  conversation" — checks it against the batch, and stores it as `source = 'agent'` with the model named;
- `conversations build` chooses the agent's answer over a rule's guess, and keeps it across rebuilds; an
  answer whose message changed goes stale and is asked again;
- a skill tells the agent how to run the loop, and to confirm scope with the user first.

No model call, no network, no API key in the CLI. Phase 5 (chunks, embeddings) is not built here.

## 2. Depends on

- **Phase 3 merged and released**: tables of store version 13, `replaceConversations`, the
  `conversations` commands ([`phase-3.md`](phase-3.md)). Phase 3 waits for phase 2's version 12.
- **No new migration** (A9). If item 1 finds one needed, it takes the next free number in
  [`../../plans/2026-09-29-parity-lanes.md`](../../plans/2026-09-29-parity-lanes.md) first — 13 is phase
  3's, 14 is "chats the account has left".

## 3. What we know

**The table already holds an agent's link** (verified, `src/store/sqlite/schema.ts:285-320` at
`8108fd6`): `message_links` has `source`, `kind`, `confidence`, `method` (the rule's name, or the
agent's model), `version`, `batch`, `created_at`, `stale_at`, and `build` — `NULL` for an agent's link,
which outlives rebuilds. One unique index covers every link, with `ifnull` for a missing parent
(`:313`).

**A rebuild keeps agent links and marks stale ones** (verified, `src/store/sqlite/conversations.ts:222`):
a link whose message or parent was edited or deleted after it was written gets `stale_at` (plan C4).
**But the rules never see agent links:** `choose` picks the messenger's reply, else the most confident
rule link (`src/conversations/link.ts:108-114`), and `Link.source` is `"provider" | "rule"` only (`:17`).
So today an agent link is stored and shown by `messages links` (`linksOf` orders provider, agent, rule,
`conversations.ts:381-405`) but does not change any conversation. Item 2 closes that.

**Where parents sit** (phase 3 plan §3, measured on two Telegram groups): 96.7% of reply parents within
50 messages back, 97.7% within 100; replies are 35–60% of messages. The rules' window is 50
(`link.ts:6`).

**Skills ship with each CLI** (verified, cli-messaging `src/cli/skill-command.ts:10-29` at `f7bfad7`):
`<cli> skill show` prints the CLI's own `skills/<cli>/SKILL.md`, shipped in the package; tg-cli
`skills/tg-cli/SKILL.md`, max-cli `skills/max-cli/SKILL.md`.

**Permissions** (verified, `src/sends/permissions.ts` at `f7bfad7`): levels `deny`, `readonly`, `ask`,
`allow`; `conversations` maps to the `messages` key, so `deny messages` reaches it (phase 3, SEC-27).

**From the literature** ([`../research/2026-09-30-disentanglement.md`](../research/2026-09-30-disentanglement.md)):
the IRC format labels **each message's parent** (itself when it starts a conversation); two humans agree
on 49.5 link F1 — an answer is a judgement, not a fact, so it carries its model and confidence. **paper**

## 4. Decisions made here

**A1 · A batch is a window: 50 messages to answer, with the 50 before them as context.** The agent
answers only the core messages; a parent may be in the core or the context. Why: 97% of parents sit
within 50 messages back (§3), so a core message's parent is almost always in view, and consecutive
batches overlap by their context — no conversation breaks at a boundary (requirements §13 stage 3).
`--size <n>` changes the core, 10–200. *Inferred:* a batch of 100 short messages is a few thousand
words; the skill keeps the agent's turn small.

**A2 · Which messages need the agent.** A live message with **no messenger reply link and no fresh agent
answer**. A reply from the messenger is a fact (C1 puts it first), so the agent is never asked about it;
it still appears in batches as context and as a candidate. A stale agent answer makes its message need
the agent again — that is how "ask again" works (C4). `batches next` returns the earliest window whose
core holds such messages; the core is those messages, up to `--size`, in order.

**A3 · No batch table: a batch id names its window.** The id encodes chat, the core's first and last
message and a hash of the core's message ids: `b1.<chat key>.<first pk>.<last pk>.<hash>`. `links add`
recomputes the core from the id and refuses the answer if the chat changed under it (a message deleted
or added inside the core). Why: nothing to clean up, nothing to expire, and "resume" is just asking for
the next batch — the store already says which messages are answered. The id goes into
`message_links.batch`.

**A4 · What a batch prints.** Per message: id, time, sender (name and id), text, the messenger's reply
target, thread, mentions — and, for core messages, the candidate links with source, kind, confidence.
JSON is the only shape the skill uses; `--json` and `--jsonl` as everywhere, pretty for a person
reading along. **Message text goes to stdout only** — the agent's own context — never to a log, a run
record or a file (max-cli constraint 6). Item 1 checks that the run recorder (`src/cli/runs/`) keeps no
output.

**A5 · The answer format and how it is checked.** stdin, JSON:

```json
{ "model": "claude-sonnet-5-5", "answers": [
  { "message": "4028", "parent": "4019", "confidence": 0.83 },
  { "message": "4030", "parent": null, "confidence": 0.7 }
] }
```

`links add --batch <id>` refuses the whole answer, storing nothing, when: the batch no longer matches
(A3); a `message` is not in the core; a `parent` is not in the batch, or is not earlier than its message;
a message appears twice; a confidence is outside 0–1; `model` is missing. Missing messages are allowed —
they stay unanswered and come back in the next batch. Each stored row: `source = 'agent'`,
`kind = 'answer'`, `method` = the model, `version` = the skill's version (A8), `batch` = the id, `build`
`NULL`. A message's new answer **replaces** its earlier agent answer — one current answer per message.

**A6 · How agent answers enter the conversations.** `conversations build` reads the chat's fresh agent
answers and passes them to the rules; `choose` becomes: messenger reply, then agent answer, then the best
rule link (C1's order). An agent "starts a conversation" stops any rule link for that message. A stale
answer is not used (C4). `links add` does **not** rebuild — at 1M messages a rebuild is ~27 s; the skill
runs `conversations build` once at the end, or every N batches.

**A7 · Cost and consent stay with the agent.** The CLI cannot price the user's model, so
`batches status` reports messages, batches and characters (a token estimate is characters ÷ 4,
labelled as an estimate). The skill makes the agent state chat, scope and that estimate, and wait for
the user's yes, before the first batch (requirements §15's intent, without `--max-cost`). Whether the CLI
also records a per-chat consent is **NEED-497** — recommended: no, the skill's question is enough.

**A8 · One shared skill, shipped by cli-messaging.** `skills/link-conversations/SKILL.md`, written once,
with the CLI's command name filled in at print time; `<cli> skill show link-conversations` prints it
(the existing `skill show` gains an optional name). Its front-matter `version` goes into every answer's
`version` column, so links written under an older prompt can be told apart. The CLIs' own SKILL.md gain
one line pointing at it.

**A9 · No migration.** Everything A1–A8 needs exists in version 13: `batch`, `method`, `version`,
`stale_at`, `build NULL`, and the unique index. Finding the messages that need the agent (A2) is
`NOT EXISTS` over the unique index's leading `message_pk`.

**A10 · Permissions.** `conversations links add` is a write to the local store only — nobody else sees
it — so it gets its own key, `conversations.links`, not `messages`: a profile `readonly` on messages can
still be allowed to link. Reads stay under `messages`. `conversations links clear --chat <chat>
[--model <m>]` drops agent answers (requirements §23 `drop-enrichment`); messages are never touched.

**A11 · MCP.** Phase 4 is CLI and skill, as ruled. MCP tools for batches and answers are **NEED-498** —
recommended later.

**A12 · What phase 5 needs from this.** Conversations stay the unit a chunk is cut from; nothing here
stores text outside `messages`. An answer's `version` and `method` let phase 5 rebuild chunks when the
links under them change.

## 5. Work items

1. ✅ 2026-10-01 · **Batches** — store: messages needing the agent (A2), the window around them (A1), the batch id
   (A3); service and commands `conversations batches status|next` (A4, A7). Check that run records keep no
   output. No migration (A9).
2. **Agent answers into the choice** — `LinkInput`/`linkMessages` take the chat's fresh agent answers;
   `choose` in C1's order (A6); `RULES_VERSION` up so `store check` names chats to rebuild.
3. **`conversations links add|clear`** — validation (A5), replace-per-message, the `conversations.links`
   permission key (A10).
4. **The skill** — `skills/link-conversations/SKILL.md`, `skill show <name>` (A8), one line in tg-cli's and
   max-cli's SKILL.md (a PR in each).
5. **Scoring the loop** — `bench/disentangle/` runs the loop with a scripted "agent" that answers from the
   IRC gold links, to prove batches + answers + build reproduce the gold conversations exactly; and, by
   hand, once with a real agent on the IRC dev split, link F1 against the rules alone. Numbers only.
6. **Docs, changelog, parity rows** (planned until tg and max mount them), release; tg-cli and max-cli
   bump.

## 6. Test plan

- **Windows**: core and context bounds; a chat shorter than a batch; the earliest unanswered message
  first; messages with a messenger reply are context, never core; a stale answer comes back.
- **Batch id**: refused after a message inside the core is deleted or a new one lands inside it;
  accepted after a message outside the core changes.
- **Validation** (each case refuses the whole answer, stores nothing): message outside the core, parent
  outside the batch, parent later than its message, a duplicate, confidence 1.5, no model.
- **Replace**: a second answer for a message replaces the first; the same answer twice is one row.
- **Choice**: messenger reply beats agent beats rule; an agent "starts" removes the rule's parent; a
  stale agent answer is ignored; the rebuild keeps agent rows (C4, already tested in phase 3).
- **Privacy**: no message text in run records, logs or `store check`.
- **Permissions**: `deny messages` refuses `batches next`; `readonly` messages with
  `conversations.links = allow` accepts `links add`.
- **Machine mode**: stdout one JSON value; notes on stderr.
- **End to end** (item 5): scripted agent from gold links → conversations equal the gold clustering.

## 7. Open questions

1. ~~**NEED-497**~~ — decided by default 2026-10-01: **A**, the skill asks; the CLI records nothing. A per-chat consent recorded by the CLI before batches, or only the skill asking the
   user (**A**, recommended)?
2. ~~**NEED-498**~~ — decided by default 2026-10-01: **A**, CLI and skill only; MCP later. MCP tools for batches and answers now (**B**), or CLI and skill only, MCP later (**A**,
   recommended)?
