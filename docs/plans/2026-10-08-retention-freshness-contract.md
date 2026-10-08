# Retention and counter observation command contract

Owner approved on 2026-10-08. Planned availability lives in parity.json; implementation follows
migration reservation24. Both MAX and Telegram use the same hierarchy and shared services.

| Path | Purpose | Default |
|---|---|---|
| `stats chats retention <chat>` | Known-join cohorts, checkpoint membership, activity and early-departure bounds | Last90d joins; weekly cohorts; checkpoints1d,7d,30d; within7d |
| `stats messages counters show [query...]` | Held counter values, observation times/provenance and freshness | Views/reactions/comments; max-age24h; limit20 |
| `stats messages counters refresh [query...]` | Explicit bounded counter reads with atomic local observation updates | Limit20/max100; sync-time30s |

Retention is alongside newcomers. Counters names a distinct part of messages; show/refresh are
separate actions, rather than more modes of ranking or search. Parent help exposes those paths.
The existing three-tool MCP frontend discovers/executes the same operations with shared schemas.

Retention uses since-time/until-time for joining dates, timezone/by for calendar cohorts, within
for the measured post-join window, and checkpoints for positive elapsed ages. The first observation
at/after each checkpoint within24h tolerance is exposed with its actual time. Missing/partial lists
produce unknown absence; pending checkpoints do not become zero. Rates disclose observable,
unknown and pending denominators. Departures are intervals, never exact goneAt times.

Counters reuse strict Lucene chat/source/timezone/exact scope. counters selects explicit metric
fields; fields retains its unrelated global output-projection meaning. max-age only classifies
observation age and does not guarantee current server state. Existing data have unknown observation
time. The within catalogue now describes an observation window after known joining; newcomer help
keeps its existing semantics and default7d.

Refresh requires an explicit resolved chat or a versioned exact locator selection, no silent
account-wide default. Selection conflicts with additional query/scope options. Global dry-run
previews exact bounded targets/counters/capabilities without connecting. Refresh reads remote
counters and writes only local data: it never sends, marks read or increments views. Permission
uses the full leaf plus message reads/local store update policy; profile denial precedes requests.
Unsupported fields and partial failures are explicit. No background refresh or implicit sync.

Only explicitly supplied authoritative counter values acquire their own observation timestamp.
Missing counters are not zero; independent fields keep independent times. Local/imported values
and ingestion/request timestamps do not establish observation freshness. Value-bound timestamps
are invalidated logically when legacy writers supply a different unobserved value. Counter-only
updates preserve message text, graph, attachments and tombstones.

Retained membership batches and latest-only counter observations are additive storage. Cohort and
counter evidence use typed versioned selectors, authorized scopes, bounded pages and fingerprinted
continuation. Changed membership/counter observations require a restart. No full group silent-member
percentage from partial membership or message history. Public guides explain these limits and
both consumers adopt one verified published SDK.
