# Synthetic CLI agent evaluation — 2026-10-06

Two independent Codex agents received the messenger skill, six user tasks and an isolated CLI
fixture. Each invocation recorded command paths, exit codes, output bytes and result metadata;
no message bodies, credentials or policy reasoning were retained in metrics. No real account,
keyring, network or external provider model API was used.

| Task | Initial calls / bytes | Final calls / bytes | Final outcome |
|---|---|---|---|
| discovery | 3 / 7409 | 1 / 3574 | passed |
| ambiguity | 2 / 354 | 2 / 354 | passed |
| pagination | 2 / 259 | 2 / 259 | passed |
| validation-recovery | 3 / 3627 | 3 / 3627 | passed |
| compact-output | 3 / 260 | 2 / 143 | passed |
| unknown-write | 5 / 7231 | 4 / 6889 | passed |

The first pass found missing schema/projection/journal guidance and an empty result for
`--fields items.id`. Skills now route those requests directly, clarify provider-confirmed retry
safety and use valid folded YAML. Projection supports `items.id` as well as item-relative `id`.
Both agents attempted the unknown write exactly once and inspected its outcome without replay.

The final pass completed all six tasks in 14 calls and 14,846 output bytes. These observations
do not isolate model quality or establish general messenger conformance. The initial fixture used
an invented `sends show` view, corrected to the actual `sends list` view for the final pass; the
final compact task also read two pages instead of one. Treat costs as recorded observations,
not a causal improvement claim.

The deterministic `evaluateAgent` baseline separately checks harness correctness and fails
replay, call-limit violations and crashed policies. It does not measure a language model.

[Metrics](2026-10-06-cli-agent-metrics.json) · [testing guidance](../TESTING.md)
