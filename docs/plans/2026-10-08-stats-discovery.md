# Statistics name discovery and recovery

Status: implementation, integration checks and48 fresh evaluations complete on `fix/stats-discovery`. Owner approved the plan on 8 October 2026. Consumer adoption/publication is separate.

Resolve selected answering identities from authorised stored names, aliases and usernames within
query accounts. Reject unknown names with recovery guidance, return scoped ambiguity candidates,
and distinguish an explicitly selected unseen ID from a known identity with zero observed replies.
Keep statistics local-only and pin resolved IDs in saved selections. Repair synthetic discovery
and evaluate normal names and recovery separately from the historical ID-based statistics results.

Validation: account/scoping/rename/unknown-ID regressions, fixture discovery preflight, full shared
gates and fresh repeated CLI/native-MCP tasks through verified ChatGPT authentication. No live
messenger actions or paid API fallback. Consumer adoption/release remains a separately recorded step.

[Evaluation report](../dev/evaluations/2026-10-08-natural-name-stats-evaluation.md) records48/48 trace and final criteria passes; original studies are preserved.
