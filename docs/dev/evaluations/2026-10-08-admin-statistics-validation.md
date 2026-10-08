# Administrator statistics validation

Source: shared feature head `1f25bcf80f3d3d9108b55c61dd5b51712f4455a5`, merged in
[PR720](https://github.com/leemour/cli-messaging/pull/720). Published SDK0.178.0 source/tag:
`eac198e2c755bf4324174f78464cadbe6ac4c7bf`; release workflow
[37699445726](https://github.com/leemour/cli-messaging/actions/runs/37699445726) completed build,
publish and tag. The registry integrity matched the inspected Actions artifact. That artifact
contains the four report services, the existing evidence items envelope and invite-link switches.

The [command contract](../../plans/2026-10-08-admin-statistics-contract.md) was approved before
implementation in [PR716](https://github.com/leemour/cli-messaging/pull/716). Public task guidance
stays in the [ranking guide](../../rankings.md#find-questions-and-posts-that-need-attention).

## What was exercised

Synthetic SQLite stores, CLI run entry points and the actual three-tool MCP protocol surface:

- Root query/date/author filters select questions; explicit replies after the selected date period
  remain eligible answer context. An admin speaking next without a reply does not close a question.
- Selected answerer identities, first eligible reply attribution, zero responders with null latency,
  future-question exclusion and role scope recorded as user-selected identities.
- Known joining dates versus first observations; bounded newcomer windows and stable stay references.
- Channel views versus direct stored discussion and separate comment snapshots; linked-copy collapse.
- Bounded question/answer evidence, actual JSON byte limits, cursor changes, invalid selectors and
  cancellation; CLI JSONL uses the same evidence item envelope as existing rankings.
- Saved scope reruns, typed report option overrides, incompatible report kinds and no stored bodies.
- Native adoption follows both evidence targets and saved reports without connecting. Message-read
  refusal and MCP discovery preserve the current three frontends.
- Unsupported MAX invite-link list/revoke are omitted in CLI/MCP discovery. Telegram keeps its
  independently implemented adapters; statistics do not exercise those live writes.

These are deterministic synthetic workflow tests, not an independent LLM-agent evaluation or a
real-account test. No owner store, credentials, live fetch, send or mark-read was used.

## Results

| Tree | Tests | Line coverage | Matrix |
|---|---|---|---|
| Shared feature | 2508 passed, 2 skipped | 94.43% | Both native consumer compatibility jobs green |
| Shared completion metadata | 2512 passed, 2 skipped | 94.43% | Four report paths required in both consumers |
| MAX published SDK178 adoption | 1508 passed, 2 skipped | 92.16% | 828 tested, 107 documented, 0 missing |
| TG published SDK178 adoption | 1288 passed, 1 skipped | 94.60% | 2259 tested, 60 documented, 0 missing |

Lint, typecheck, docs and Bun smoke passed. Native generated references, agent-doc/discovery checks
and parity passed. Local full runs used two workers and a 30-second test timeout after load-related
5-second timeouts in pre-existing encryption/history tests; normal shared exact-head CI passed.
Native PRs: [MAX472](https://github.com/leemour/max-cli/pull/472),
[TG349](https://github.com/leemour/tg-cli/pull/349). Their final merge/check evidence is recorded in
those PRs. Application npm/binary releases and portal reviewed-release sync remain separate work.

## Interpretation limits

Question detection is the versioned question-mark heuristic. A qualifying reply does not prove
useful assistance, and requested answerers do not prove historical administrator roles. Missing
joining dates do not become first-seen join dates. Missing history/links/counters do not become
confirmed zero; counters have unknown observation freshness. These reports describe held data.
