# Ranking stored messages and authors

Statistics use `stats → resource → view`. Replace `app` below with `max` or `tg`.
The commands read the local store and do not connect by default. Fetch the relevant history
first; a ranking describes held data, not all activity in the messenger.

```sh
app stats messages top 'chat:room date:[2026-10-01 TO 2026-10-08}' --measure reactions --limit 10 --json
app stats contacts top 'chat:room date:[2026-10-01 TO 2026-10-08}' --score helpful --min-messages 3 --json
app stats contacts top --weights '{"messages":0.4,"active-days":0.6}' --timezone Europe/Madrid --json
```

## Measures and scores

| Target | Measures | Default |
|---|---|---|
| Messages | views, reactions, forwards, comments, replies, thread-size | reactions |
| Human authors | messages, words, reactions, replies, answers, answer-time, threads, active-days | messages |

`answer-time` sorts ascending by median milliseconds; the other measures sort descending.
`--message-kind posts` or `comments` selects proven kinds before aggregation.
Unknown old linkage is reported rather than guessed. Linked channel comments may live in a
stored discussion group; the answer lists expanded discussion chats and their coverage.

`--score helpful` weights answers 0.5, replies from others 0.25 and reactions 0.25.
`--score active` weights active days 0.6 and messages 0.4. Both apply to authors.
`--score engaging` weights reactions and nonself replies equally; author scores use per-message
rates and require five selected messages unless `--min-messages` overrides that threshold.
`--weights` replaces every preset weight. Names must be supported components for the target,
weights finite and nonnegative, and at least one positive. `--measure` conflicts with scores.

Score version 1 normalizes each component against the maximum among all eligible rows before
`--limit`: `100 × sum(weight × value / maximum) / sum(weight)`. A zero maximum contributes zero.
Missing positive components exclude a row from scoring. A zero weight ignores that component.
The response includes maxima, component values, contributions and exclusion counts.

## Scope and quality

Queries use strict Lucene with `--chat`, `--source`, `--exact` and `--timezone` as in message search.
A top page contains 1–100 rows. Text and author predicates select ranked messages; reply context
uses authorized stored messages in the same query period without those text or author filters.
Graph metrics reject ambiguous date branches: use a common positive date range.

Views, reactions, forwards and comment counters are cumulative stored snapshots. Their
observation time and freshness are unknown; a date filter selects messages, not reactions
received within that period. Unknown counters are distinct from zero. Author reaction totals
can be partial, with known and unknown message counts. `--sync-first` is guarded and bounded;
it fetches newer messages and does not refresh old counters.

Answers are a heuristic: a question contains `?` after URL removal, and its first direct reply
by another known human author is credited. Self replies and channel identities do not qualify.
Words use version 1 letter/digit runs with URLs removed. Active days use the selected timezone.
Coverage and graph quality tell you when held history is incomplete. No metric proves helpfulness.

## Follow the evidence

Each row returns `drilldown.selection` and exact `drilldown.evidence.arguments` for its evidence
command. Pass that selection as JSON, with the emitted message locator or native person id:

```sh
app stats messages evidence msg:tg/fixture/room/101 --selection "$selection" --component replies --limit 20 --json
app stats contacts evidence 42 --selection "$selection" --component answers --limit 20 --json
```

Replies include their parent; answers include the question and credited answer. Snapshot metrics
show measured messages, not lists of viewers or reactors. Author `messages` evidence exposes
all selected messages even when ranking by a score. Active-day evidence lists underlying
messages; its one-per-message contributions are not summed into distinct days.

Evidence includes `total`, `included`, `hasMore` and `nextCursor`. Continue with the same
arguments and `--cursor`. A changed contributing row rejects the cursor; restart without it.
Each page retains complete rows within a 64 KiB items budget. An oversized single row directs
you to `messages show`. Fingerprinting is bounded to 50,000 rows and 8 MiB of stored inputs;
narrow chat/date scope when the query exceeds a budget. Selection JSON is capped at 64 KiB.

## Find questions and posts that need attention

After loading the relevant history, you can ask your agent: “Show questions in the club that have
waited more than a day, and open the original messages.” These reports read the stored archive;
an empty report cannot prove that nobody asked a question when history is missing.

```sh
app stats messages unanswered --chat Club --older-than 24h --json
app stats contacts responses --chat Club --answerer 42 --answerer 73 --json
app stats chats newcomers Club --since-time 2026-10-01T00:00:00Z --within 7d --json
app stats messages discussion --chat News --min-views 100 --max-replies 0 --json
```

`unanswered` orders detected questions by age. A question contains `?` outside URLs; this is a
heuristic. Only a direct explicit reply from another identifiable human qualifies. A later reply
can answer a question even when its date/text does not match the question query. Replies to oneself
and the next speaker without a reply link do not qualify. `no-observed-answer` describes saved
history, rather than proof that no answer exists in the messenger.

`responses` requires the identities to measure with repeated `--answerer`. They are user-selected
people, not verified past administrator roles. It shows response count, median and p90 latency in
milliseconds; no response gives null timings. P90 uses the nearest rank, rounded up. Without
`--answerer`, unanswered and newcomer reports accept any other identifiable human. Bare ids need
one scoped account; use `person:<provider>/<account>/<id>` for multiple accounts.

`newcomers` defaults to joins in the last 30 days and questions within seven days after a known
join. `--until-time` ends the join cohort. First-seen-only identities are counted separately in
`summary.unknownJoin`, not assigned a joining date. A rejoin is a separate stay. Pending help windows
and incomplete member history are reported; no saved question does not mean no help was needed.

`discussion` compares known cumulative views with observed direct discussion replies. Provider
comment snapshots remain separate; their freshness is unknown. Linked discussion needs stored
link metadata and its group's history. Missing counters or graph links are not zero.

Each row provides `drilldown.command` and exact arguments. Run its existing messages/contacts
`evidence` command with `--component report` and the returned selection. Follow `nextCursor` with
the same arguments. The captured cutoff remains fixed; changed evidence requires a fresh report.
Evidence items fit within 64 KiB. Narrow the chat/date scope if the 50,000-node or 8 MiB budget is
exceeded. Look at `quality.archives` and `quality.graph` before drawing conclusions, then open the
returned message locator with `messages show` to check the original context.

You can save a report's returned selection with `searches create waiting --selection "$selection"`
and rerun the matching view with `--saved waiting`. Resolved accounts, chat, root dates and answerers
remain pinned; typed report options replace inherited values. Each new run captures a fresh observation
cutoff for replies. A saved report cannot run as a different report kind or an ordinary ranking.
Report history stores parameters and resolved selections, never result messages. Evidence is not recorded.

## Save a resolved ranking

```sh
app searches create weekly --selection "$selection"
app stats contacts top --saved weekly --limit 20 --json
```

Use the matching message/contacts target. Resolved ids and date boundaries stay pinned;
additional query words narrow the saved scope. Typed ranking options replace stored ones.
Pinned selections read held data and refuse `--sync-first`; run an ordinary query to refresh.
History records parameters, not result bodies. Evidence is never recorded as search history.

MCP discovers and invokes these same paths through the existing three-tool frontend. Selection
is a structured object there. See the [command contract](plans/2026-10-07-rankings-contract.md)
and [CLI standard](dev/STANDARD.md) for the public interface and standards references.
