# Message and author rankings: command contract

Status 2026-10-07: the owner approved the ranking plan, the `stats → resource → view` hierarchy,
and the exact evidence views/options in naming PR671. The naming contract is merged.
Implementation is in progress, starting with the shared compiled SQL selection. The command
paths remain planned until their runtime implementation is shipped. Further approval of these
names is not required.

## Surface

| Command | Purpose |
|---|---|
| `stats messages top [query...]` | Rank distinct matching stored messages. |
| `stats contacts top [query...]` | Rank the human authors of matching stored messages, separately per provider/account/identity. |
| `stats messages evidence <message>` | page through the messages contributing to one message's metric. |
| `stats contacts evidence <person>` | page through the messages or question/answer pairs contributing to one author's metric. |

All are local reads. `top` optionally accepts the existing guarded `--sync-first` preparation;
evidence never fetches. No ranking sends, marks read or moderates. Ordinary message search,
statistics totals and existing `messages evidence <chat>` retain their contracts.
MCP invokes the same paths through `<app>_read`; no per-command MCP tool is added.

### Ranking options

Both top views accept existing `--chat`, `--source`, `--timezone`, `--limit`, `--saved`,
`--exact` and search sync options. Default limit is the existing profile setting, capped at
100 ranking rows; invalid limits fail rather than silently clamp. Query words use strict
Lucene. Legacy/regex search modes, newest/relevance ordering and context expansion are absent.
Lucene regex predicates retain their candidate/work/time budgets.

| Option | Meaning |
|---|---|
| `--measure <name>` | Messages: views, reactions (default), forwards, comments, replies, thread-size. Authors: messages (default), words, reactions, replies, answers, answer-time, threads, active-days. |
| `--score <helpful|active|engaging>` | Choose the approved score preset; helpful and active apply to authors, engaging to either target. |
| `--weights <json>` | Replace all preset weights, or define a custom score; a JSON object of known component names to finite nonnegative numbers, with at least one positive weight. |
| `--min-messages <n>` | Authors only: minimum selected messages, default 1; engaging defaults to 5 unless explicitly overridden. |
| `--message-kind <all|posts|comments>` | Select the ranked message population before aggregation; all is the default. Unknown kinds are excluded only when a specific kind is requested. |

An explicitly supplied measure conflicts with score/weights. Unsupported presets, unknown
weight keys and target-inappropriate options fail. A score preset with explicit weights uses
exactly those weights; a zero weight removes that component's completeness requirement.
No custom score component accepts answer-time in v1.

### Approved evidence options

Both evidence views require `--selection <json>` and `--component <name>`, and accept
`--limit <n>` (1–100, default 20) and `--cursor <cursor>`. Message arguments are canonical
message locators. Person arguments are the exact native identity id emitted by the author row;
the selection binds its provider and account, so a name is never re-resolved.

`selection` is the versioned structured selection returned in a ranking's drilldown: validated
AST, resolved account/chat scope, context date range, timezone, message kind and target key.
It carries no message body, credentials, arbitrary SQL or authority. Every read validates and
authorises the supplied scope again. A profile/source restriction or permission refusal must
not be bypassable by editing this object. Selection input is capped at 64 KiB inside the
existing input limit. CLI receives JSON; MCP receives the corresponding structured object.

Component names are the requested measure or a score component exposed in that row. Replies
return parent/reply locators; answers and answer-time return question/credited-answer locators
and delay; thread-size/threads return root/descendant locators. Snapshot counters return the
measured messages, never an invented list of reactors or viewers. Words and active-days return
the selected messages and their contribution. Self replies remain visible in raw replies;
the `replies-from-others` component excludes them.

Cursor paging orders by timestamp and full canonical locator, not an id alone. A cursor is bound
to selection, component and a fingerprint of the contributing stored rows. Changed evidence
fails with a restart instruction instead of silently mixing snapshots. Each response reports
total, included, hasMore and nextCursor. Byte limits retain complete rows and return continuation;
they never silently omit evidence. Raw evidence is not logged or saved as search history.

Example continuation, with synthetic ids and abbreviated selection:

```text
stats messages evidence msg:tg/fixture/channel/101 --component replies --selection '{...}' --limit 20
stats contacts evidence 42 --component answers --selection '{...}' --limit 20
```

## Population and metrics

S is the distinct, undeleted matching message set after resolved account/chat scope and kind.
C is the stored, undeleted reply context in the authorised accounts/chats, with the same date
range but without S's author/text/attachment filters. Context metrics reject a query whose date
constraints cannot be reduced to one required positive range; no date means all held history.
Account + chat + native message id identifies an edge. Topic ids alone are not reply edges.

| Metric | Definition |
|---|---|
| views / forwards / comments | Finite nonnegative provider snapshot counter; missing/invalid is unknown. Comments is a provider total, not a local reply count. |
| reactions | Finite nonnegative snapshot total; missing is unknown, including for an author's sum. |
| replies | Distinct direct replies from C to messages in S; report self replies separately. |
| thread-size | Distinct reachable reply descendants from C, excluding the root; cycles and duplicate paths cannot multiply rows. |
| messages | Author's messages in S. Unknown or chat senders do not become people. |
| words | Unicode letter/number tokens in stored message text after removing URLs; no file text/transcripts; report tokenizer version. |
| answers | First direct nonself human reply to a question containing `?` after URL removal; credit its author only if the answer belongs to S. Only nonnegative answer delays qualify; timestamp/locator resolves ties; one credit per question. |
| answer-time | Median credited answer delay in milliseconds, ascending; no credited answers means null. |
| threads | Selected root messages with at least one proven descendant in C; standalone posts/topics are not threads. |
| active-days | Distinct calendar days of selected messages in the requested IANA timezone. |

Posts are proven channel posts or group roots. Comments are proven group-root descendants.
A channel's comments require an authorised linked discussion group, an automatically forwarded
root, and its source channel/post linkage. An ordinary forward is insufficient. The selection
reports any linked scope expansion and its coverage; it never opens the network to discover it.
Older rows without evidence remain unknown, including when new mapper fields are added.

Current source at `c24ea29`: the store has reply ids but no explicit cross-chat reply target;
the Telegram mapper at `b80d0ea` saves views/forwards/comments but does not save linked-group/forwarded-root
evidence. Domain/store/mapper additions are therefore necessary before claiming channel comment
ranking. Telegram's primary semantics: [discussion groups](https://core.telegram.org/api/discussion)
and [message threads](https://core.telegram.org/api/threads). These are source/doc observations,
not live account measurements.

## Scores and output

Score version 1 is `100 × sum(weight × value/max) / sum(weight)`; a zero maximum contributes 0.
Compute maxima over the entire eligible population before applying result limit. Eligibility
applies scope/kind/minimum messages and requires every positive-weight component to be known.
Never turn unknown counters into zero or change the denominator per row.

| Preset | Components and weights |
|---|---|
| helpful (authors) | answers .5, replies-from-others .25, reactions .25 |
| active (authors) | active-days .6, messages .4 |
| engaging (authors) | reactions-per-message .5, replies-from-others-per-message .5 |
| engaging (messages) | reactions .5, replies-from-others .5 |

Custom scores accept the target's non-time measures plus these explicitly named nonself/ratio
components. A single author reaction metric may rank the sum of known counters as a labelled
partial lower bound, with known/unknown message counts; scores exclude such incomplete rows.
All-zero measured rows remain eligible. All-unknown components produce an empty eligible set
and a clear diagnostic, rather than a fabricated zero leaderboard.

JSON returns one bounded object with items/page/limit/hasMore, total matching messages,
population/eligible/exclusion counts, query metadata, coverage/completeness and ranking metadata.
Rows include a unique deterministic rank, value, `ranking.score` where applicable, raw and
normalised components, sample sizes, quality and structured drilldown. Ties use full canonical
message or provider/account/person keys. IDs are strings.

Normalization metadata includes version, weights, maxima and population; scores are not
comparable across queries or periods. Snapshot counters are cumulative, not period deltas.
Counter freshness is unknown: ingestedAt/fetchedAt cannot establish when each counter was seen.
Local reply counts describe held history, not server totals. `--sync-first` does not refresh old
counters. JSONL contains complete ranked rows and their quality; common restrictions remain in
JSON/schema documentation and diagnostics stay on stderr.

Saved searches store target, query/AST, timezone, kind, weights/preset, measure and minimum
messages. Explicit options replace saved options; rank views reject incompatible legacy fields.
Persisted search parameters never include result bodies, evidence or cursors. Person drilldown
ANDs an exact sender constraint with the entire original Boolean AST and retains resolved scope.

## Implementation and acceptance

1. Naming contract PR671 is merged and approved before command code.
2. Extract a shared compiled selection from the Lucene matcher. Exact queries stay SQL CTEs;
   detector candidates stay bounded and budget exhaustion is an incomplete error, never a partial
   leaderboard. No unbounded queryMessagePks array or account-wide body materialization.
   The existing filename/mime compiler also collects matching attachment message keys in JS;
   the ranking path must bound or replace that intermediate selection, not merely remove the
   final queryMessagePks call. Preserve existing search behavior and its index drivers.
3. Build SQL aggregation and bounded calculators in one read snapshot; hydrate only result/evidence
   pages. Preserve search/count behavior, exact/stemmed/index drivers and permission scope.
4. Add graph/discussion evidence and the provider mapper. Announce any required migration number
   separately before adding it; current next-free number is 22, subject to recheck.
5. Wire CLI, MCP read paths, schemas/effects, saved parameters, permissions and user skills/docs.
6. Verify all metrics and scores, missing values, deleted rows, author/account collisions, Boolean
   scope, ambiguous date branches, graph cycles, channel comments, self replies, median/timezones,
   limit-independent maxima, evidence continuation and absence of remote writes/mark-read.
7. Run synthetic large-history EXPLAIN and budget/abort checks, full Node/Bun suites, generated
   references, parity/matrices and exact-head consumer CI after the shared SDK release/adoption.

No real account, keyring or messenger operation is part of this implementation. Consumer binary
publication and any live validation remain separate work.
