# Administrator statistics command contract

Owner approved on 2026-10-08. This names the shared MAX/Telegram reports; availability is
tracked in parity.json. The shared implementation is complete; native adoption evidence accompanies
the final validation report. No new root commands or remote writes.

| Path | Purpose | Required input |
|---|---|---|
| `stats messages unanswered [query...]` | Oldest detected questions without an observed qualifying explicit reply | Optional repeated `--answerer`; `--older-than` defaults to 24h |
| `stats contacts responses [query...]` | Counts and median/p90 latency for selected human answering identities | Repeated `--answerer` |
| `stats chats newcomers <chat>` | Known-join members and their help within a join window | `--within` defaults to 7d; since-time/until-time select join dates |
| `stats messages discussion [query...]` | Viewed posts with little recorded discussion | `--min-views` defaults to 1, `--max-replies` to 0 |

Parent help exposes unanswered/discussion beside show/top/evidence, responses beside top/evidence,
and newcomers beside show/official. Each leaf is a distinct report, rather than a ranking metric.
The corresponding shared execution schemas are stats_messages_unanswered, stats_contacts_responses,
stats_chats_newcomers and stats_messages_discussion, reached through the existing three MCP tools.

Query reports reuse chat/source/timezone/exact/limit. Default limit is 20, maximum 100. All reads
use authorized stored accounts/chats; no implicit fetch or role discovery. The answerer option names
selected identities, not proof that those people held an administrator role at the message time.
Bare ids require single-account scope; qualified references carry provider/account/native identity.

Question selection obeys query/date filters. Answer context ignores root text/author filters and
extends through a captured observation cutoff. Only first qualifying direct explicit replies from
another identifiable human count. Existing inbox/chat-stats heuristics keep their existing behaviour.
Question detection is a versioned heuristic, not natural-language classification.

First-seen is not actual joining. Unknown joinedAt is a separate observed cohort, never assigned a
join window. Missing graph/history/counters are unknown or partial, never fabricated zero. Viewed
post reports separate stored reply counts from provider comment snapshots and report freshness
unknown. Evidence stays bounded to 64 KiB pages, binds query/options/cutoff and requires restart
when stored evidence changes. No moderation or automatic task creation.

The existing `--saved` option runs a saved report of the same kind. Typed report options replace
inherited values; root accounts/chat/date resolution remains pinned, and a fresh observation cutoff
is captured. `searches create --selection` accepts report selections without executing the report.
