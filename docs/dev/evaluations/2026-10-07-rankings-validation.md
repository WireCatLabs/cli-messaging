# Stored rankings validation — 2026-10-07

The approved `stats → resource → view` surface is implemented through shared services and SQL
selection. CLI and the existing three-tool MCP frontend expose the same ranking/evidence paths.

## Shipped sources

| Stage | Evidence |
|---|---|
| Names/options | [Shared #671](https://github.com/leemour/cli-messaging/pull/671) |
| Compiled selection | [Shared #675](https://github.com/leemour/cli-messaging/pull/675) |
| SQL metrics and scores | [Shared #681](https://github.com/leemour/cli-messaging/pull/681) |
| Services, CLI/MCP and evidence | [Shared #696](https://github.com/leemour/cli-messaging/pull/696) |
| Serialized fingerprint bound | [Shared #701](https://github.com/leemour/cli-messaging/pull/701) |
| Saved exclusive dates and capability discovery | [Shared #706](https://github.com/leemour/cli-messaging/pull/706) |
| SDK | 0.173.0, tagged source `a991f4bc076f6e363219120bd46626c6318948d4` |
| MAX | [#461](https://github.com/leemour/max-cli/pull/461), candidate `044bb3b6` |
| Telegram | [#339](https://github.com/leemour/tg-cli/pull/339), candidate `48b49e8` |

The [SDK publication workflow](https://github.com/leemour/cli-messaging/actions/runs/37686681072)
passed build and npm publish, then timed out waiting for registry visibility. Version 0.173.0
subsequently appeared with npm provenance metadata; its annotated tag was recovered on the
exact workflow source. Both consumers pin that published version and its lockfile integrity.
Application binary publication is a separate release step.

## Checks

| Source | Node tests | Line coverage | Other checks |
|---|---|---|---|
| Shared integration fix | 2,480 passed, 2 skipped | 94.51% | lint, typecheck, docs, Bun, exact-head CI |
| MAX adoption | 1,492 passed, 2 skipped | 92.19% | lint, typecheck, generated files, agent/config docs, docs semantics, parity, Bun |
| Telegram adoption | 1,255 passed, 1 skipped | 94.73% | lint, typecheck, generated files, agent/config docs, docs semantics, parity, Bun |

MAX matrix: 773 tested, 108 documented shared/live cases, zero missing. Telegram matrix:
2,194 tested, 65 documented shared/live cases, zero missing. Entries for other adopted SDK
features link their shared fixtures; they are distinct from tests executed in each consumer.
All exact-head consumer Linux/macOS/Windows, pack/install, version, prose and secret checks passed.

## Behaviour exercised

- Exact full-population SQL selection and score normalization before limit; scope, deletion,
  hidden chats, per-account identities, unknown counters and explicit exclusions.
- Same-period reply context, first nonself human answers, median delays, linked discussion
  copies, cycles, structural ancestors and bounded graph/text work.
- Real CLI and MCP reads without connecting; permissions before refresh connections;
  saved selections, metric/score replacement and exclusive date flags retained through storage.
- Evidence cursor continuation and changes, raw reply/answer pairs, recursive thread evidence,
  words, active days and answer delays. Oversized rows and serialized fingerprint inputs fail
  with an explicit instruction rather than silently dropping data.
- Native MAX complete/partial reply linkage and Telegram cross-chat replies, forum-topic
  ambiguity and automatic versus ordinary forwards.

These are synthetic archive and scripted-adapter checks. They do not validate fresh messenger
protocol scenarios, model-based helpfulness or subjective ranking quality. Counters remain
cumulative snapshots with unknown freshness; coverage and graph quality describe held data.
The [user guide](../../rankings.md) states these limits and the approved scoring heuristics.
