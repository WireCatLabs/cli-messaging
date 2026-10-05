# Bounded refresh before search

Implements the approved SR-3 handoff. SR-1 merged in #565–#567; SR-5 waits for SR-4.

Source evidence: `src/services/messages.ts:297` searches the store; `src/services/messages-search.ts:45`
resolves strict scopes; `src/services/archive.ts:149` owns fetching; `src/mcp/tool.ts:191` owns session lifetimes.

1. Reuse strict/legacy scope preparation and archive fetch. Defaults: 5 chats, 30 seconds, 500 messages total;
   each chat stops at its previous newest message. A bounded refresh is not proof of complete history.
2. Add `refreshed: { chats, messages, failed, complete }`. Failed or bounded refreshes label coverage stale.
   Diagnostics contain no provider error text or message content. Other accounts cannot use this connection.
3. Add CLI options and MCP arguments to message search/stats and conversation search. Gate network access
   with `messages.sync-first`; hide these MCP arguments on readonly/deny/ask profiles and reject attempts.
4. Preserve offline local reads. MAX pushed history has no archive fetch: report unsupported and stale.
   No alternate network queue, mark-read call, or release.
5. Verify fake adapter scoping, failures, time/message/chat limits, aborts, unchanged local behavior,
   saved queries, JSON purity, MCP permissions, coverage and docs. Full lint/typecheck/coverage/docs before PR.

The time budget stops between history requests; an in-flight request uses the existing provider/command
timeout and is awaited before returning. Racing it would leave adapter ingestion writing to a closed store.
The session/command still owns and closes its connection. No detached fetch continues after the answer.
