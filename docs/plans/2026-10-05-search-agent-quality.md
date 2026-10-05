# Agent graph over MCP and search quality

Scope: execute the owner's SR-4 and SR-6 handoffs. Source: private SEARCH.md and the two
2026-10-05 handoffs; these are the requested implementation scope.

Current seams: `src/services/conversations.ts` supplies batch status, batch windows, atomic answers
and rebuilds; `src/mcp/tools/conversations.ts` mounts only graph reads and embedding refresh;
`src/cli/skill-command.ts` prints the shipped linking skill. `src/services/embeddings.ts` fuses cosine
and word ranks without a floor. SR-2 is not merged at the start of this work.

1. Mount batch status/next and links add/clear over the existing service. Gate local writes by
   conversations.links; preserve read-only tools. Add a local-only build tool under that same key
   so an MCP-only agent can finish without inference or a shell.
2. Render the shipped skill as the link-conversations prompt, exactly as skill show does. Add only
   the MCP tool mapping to the skill. Keep its per-chat cost/consent gate in the prompt, with no
   session-state gate that can be bypassed by another host or protocol session.
3. Prove linking, rebuilding, stale-batch atomic refusal and permission levels through MCP with
   synthetic messages; compare prompt output with skill show.
4. Commit a synthetic labelled dev/held-out quality set. Run real e5-small outside the test sandbox;
   measure word, meaning and hybrid retrieval and candidate cosine floors. Commit machine/model/date,
   rankings and metrics. Evaluate the floor on dev before inspecting held-out results.
5. Measure a 1M-vector store scan, including load, and document the ANN verdict without dependencies.
   Change fusion only after SR-2 merges, or explicitly reject a universal floor with measurements.
6. Update docs, planned consumer parity evidence and changelog; lint, typecheck, coverage, docs and
   Bun checks before commits. Push and open GitHub PRs; merge only when every required check is green.

No model calls for graph linking, no real chats or store, no changes to linking rules, chunking or models.


## Measured implementation decision

SR-4 merged as #572 (`d6b6581`) after all required checks. SR-2 #571 and SR-10 #574
merged before this fusion patch. SR-6 uses cosine >0.80 only for `local:e5-small:384`;
other models require positive cosine. This is the dev selection under a recall-preservation
constraint, not a universal model threshold. Held-out hybrid recall89.6%→87.5%, MRR0.769→0.825,
no-answer hits30→9; the higher0.85 floor is rejected for excessive recall loss.

The complete corpus, rankings, machine/model hashes and report are in
[the benchmark](../../bench/search-quality/README.md). A1M-vector exact scan needs ANN for
interactive use (fastest4.42s); under a proposed1s scan budget,≥300k chunks demonstrate need,
with~200k as an interpolation for when to schedule it. Index implementation stays after this
closed search list. No linking, chunking or model changes are made.
