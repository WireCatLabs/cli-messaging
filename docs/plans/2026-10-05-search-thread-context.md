# Thread context around a stored message

Implements the approved SR-5 handoff after SR-4 #572 merged (`d6b6581`). Source: parent reads in
`src/services/conversations.ts:197`, store links in `src/store/sqlite/conversations.ts:431`, parent index in
`src/store/sqlite/schema.ts:363`, time context in `src/cli/messenger/messages-command.ts:109`.

1. Reuse stored links and the parent index for a bounded walk from a message locator. Follow parents and
   chosen replies within one account/chat. Defaults: 8 hops from the hit, 50 messages, 64 KiB of message/link
   JSON, 24 hours either side. Deterministic ordering, stop reasons, no conversation ids as stable references.
2. Check revisions/deletions at read time for all edge sources, not just the persisted agent stale flag.
   Label stale edges and never traverse them. Keep provenance source/kind/confidence/method/version/time.
3. Expose `--thread` on message context/search and matching MCP arguments. Thread-specific bounds avoid
   confusing network `--max-messages` with context limits. Time context remains independent; an unbuilt
   chat uses bounded local time context and says why. No network connection or model inference is added.
4. CLI, MCP and message search use one store reader. Context output says which bounds stopped it; search
   hits carry their own thread result. JSONL remains rows; notes stay on stderr.
5. Add planned parity rows, the option catalogue, docs and changelog. Verify synthetic interleaving,
   provider/rule/agent links, changed/deleted endpoints before rebuild, root answers, cycles, wrong accounts,
   large fan-out, hop/message/byte/time limits, unbuilt fallback, CLI/MCP/service parity and no mark-read.
   Lint/typecheck/full coverage/docs/Bun before committing; merge only on green CI. No release or live check.

The byte cap covers whole items plus links; the bounded metadata envelope is additional. An oversized
anchor returns no message data and a bytes stop. Message/link reads are also capped; malformed or excessive
candidate edges may stop earlier than the requested result count. No build or link rule changes, no migration.

Review correction: whole-chat freshness checks would scan unbounded history. Context reads the build time
and an indexed membership check for the hit; full-chat status remains explicit. A new hit uses not_linked
time fallback. Stale=false certifies no whole-chat freshness; link endpoints are checked locally.
The reply scan takes a bounded prefix from the existing parent index and deduplicates only that prefix.
It does not group/sort the whole reply fan-out before applying the limit. Result messages are sorted later.
