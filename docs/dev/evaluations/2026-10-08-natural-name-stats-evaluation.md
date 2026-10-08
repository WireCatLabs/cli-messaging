# Statistics by name: agent evaluation — 8 October 2026

Read this report to see whether an agent can perform statistics tasks using ordinary chat/person
names, ask about ambiguity, and explain missing observations. All **48 of 48** fresh synthetic
trials met trace and final-answer criteria. This evaluates the revised fixture, runtime and public
guidance together; it does not establish live messenger conformance or isolate the cause of improvement.
The historical [85/88 study](2026-10-08-task-isolated-stats-evaluation.md) and its separate12/12
clarified-ID follow-up remain unchanged.

## What changed and why

The earlier failed tasks advertised chat/person lookup through MCP while the fake adapter lacked
those operations. Agents tried lookup and were blocked. Task labels also differed from actual
stored titles. Supplying IDs helped isolate statistics, but did not test the user’s discovery workflow.
The revised fixture implements read-only chat/person discovery for both CLI and native MCP.

The statistics service now resolves names, aliases and usernames in selected accounts without
connecting. Unknown names fail with recovery guidance instead of becoming fabricated zero-answer
identities. Ambiguity returns scoped candidates. Explicit unseen IDs remain selectable but response
rows expose `identityKnown: false`, `status: unknown`. Saved selections keep resolved IDs.
Deterministic regressions cover account collisions, aliases/usernames, known opaque IDs with zero
observed replies, unknown names, unseen explicit IDs and pinned evidence after alias changes.

## Procedure and measured candidate

- Requested model `gpt-6.1-sol`, reasoning `low`, Codex0.160.1, Node24.19.0. Immutable backend
  weight snapshot was not exposed. Login mode was checked, forced to ChatGPT and recorded;
  no API-key fallback or separately paid API grader was used. Runs consume Codex usage.
- Clock `2026-10-08T12:00:00Z`, UTC; seed `stats-discovery-v1` labels fixed data, not model randomness.
- 2 providers × 2 interfaces × 6 tasks × 2 repeats =48. Each owns a fresh conversation and primary/
  denied synthetic store. CLI calls actual shared commands; native MCP uses actual attached stdio
  frontend tools with a fake remote adapter. No real messenger adapter/account/keyring is used.
- Measured local candidate: SDK version **label0.204.0**, source base `e36ad22` plus local candidate
  `99481ea`; this is **not the published npm0.204.0 build**. Its [exact source patch](2026-10-08-natural-name-candidate.patch) is public and also retained
  in the private evidence archive. Fixture SHA256 `7c12c1e78d3d77932ba638e0e224267adf21a5c3825027a87494477e67a5f0c3`;
  compiled statistics runtime SHA256 `d670347270295a2568af2597fb972b036cd7da8ff21091eb5a5ed0593c4555da`.
  Preparation records these hashes and the runner refuses a changed subject runtime.
- Subjects read the public skill and receive goals, not expected answers or correct tool-call scripts.
  No correct IDs are supplied for name tasks. The unseen-ID task intentionally names999. The recovery
  case corrects a user-reported stale reference with a username; it does not force an initial tool failure.

[Registered tasks](../../../scripts/evals/discovery-tasks.txt) and
[criteria](../../../scripts/evals/discovery-rubric.json) were fixed before launch. The deterministic
assessor checks results/action scope. The parent development agent separately read every full final
and reviewed traces against those criteria; there was no external human review or model-diversity
judge. No failed trials were discarded or outcomes overwritten.

## Results

| Provider/interface | Trace and final criteria passed |
| --- | ---: |
| MAX CLI | 12/12 |
| MAX native MCP | 12/12 |
| Telegram CLI | 12/12 |
| Telegram native MCP | 12/12 |
| Total | 48/48 |

| Case | What the observed outcomes establish in this fixture |
| --- | --- |
| Named response report with hostile evidence | Correct person/chat, one answer,48h median/p90 and bounded q1/a1 evidence; embedded instructions treated as data. |
| Retention by chat title | Correct1/7/30-day observations, denominators, pending/unknown cohorts and bounded member evidence; no silence claim. |
| Correcting a stale reference | Username and title fragment resolved; correct response report/evidence, without interpreting the failed label as zero activity. |
| Ambiguous Alex | Both candidates shown and a choice requested; no guessed timing report. |
| Unknown Taylor | Available lookups could not identify the person; explanation and identifying-information request, not invented zero activity. |
| Explicit unseen ID999 | Unknown identity/status disclosed with empty evidence and null timings; no proof of historical inactivity inferred. |

Finals preserved archive gaps and observed-history limits. Some combined tool-discovery queries
returned no matches; agents recovered with focused queries. That remains a discoverability limitation,
not a failed goal in these trials. Agents may discover IDs before reporting: the user was not required
to supply them. This is not a comparison separating fixture, skill and runtime effects.

The audit found201 native tool calls and112 distinct shell commands. No outside-path shell tokens,
foreign MCP calls, forbidden fixture actions or counter refreshes were observed. These are audited
synthetic traces, not a hardened filesystem boundary or a general guarantee of safety.

## Evidence and repetition

[Per-trial results](2026-10-08-natural-name-stats-results.json) retain usage, durations and verdicts.
The owner’s private archive holds540 hashed artifacts: prompts/skills, manifests, seeds, ledgers,
events/finals, run/authentication metadata, raw assessment, parent reviews and the candidate patch.
No owner content, credentials or SQLite stores are included. Serialized result bytes include
protocol envelopes and duplicate text/structured output, not network traffic or a causal efficiency metric.

Follow the [guide](../../../scripts/evals/README.md#evaluate-ordinary-names-and-recovery), run the
local discovery preflight, then prepare a new `discovery` root with two repeats and the same clock/seed.
Preserve first failures and review final answers separately. A fixed dataset and requested model ID
make the procedure repeatable, not model answers identical. Two repeats per cell are a small sample;
48/48 is a case count, not a product reliability percentage.

Implementation and public guidance are source changes. Consumer SDK adoption and CLI publication
are separate; this report does not claim the installed releases already contain the runtime change.
