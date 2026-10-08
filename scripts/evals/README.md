# Reproduce statistics agent evaluations

Use this tooling to compare a statistics task under a recorded model, SDK and fixture configuration.
It drives actual shared CLI commands or the actual MCP frontend over synthetic stores and a fake
remote adapter. It never loads a real account, login, keyring or messenger network adapter.

## Check the fixture first

```sh
pnpm build
node scripts/evals/smoke-stats-evals.mjs
node scripts/evals/check-reproducibility.mjs
node scripts/evals/check-runner-limits.mjs
```

The second check proves byte-identical fixed-clock counter reads across two fresh stores, mutation
isolation and refusal to reuse a store under a different clock/seed. Wall-clock durations use a
monotonic timer; the SDK sees the fixture clock. The seed labels the fixed synthetic dataset; it
is not a model sampling seed and does not randomize case values. All fixture processes use UTC.

## Prepare independent trials

Install the exact native candidates and locate their shared SDK directories and public skills.
Prepare a new directory. The default is one fresh context and two isolated stores per task/repeat,
with two repeats for each provider/interface cell. Expected answers remain outside subject folders.
The task prompts give actual synthetic native IDs; display names are not an entity-resolution test.

```sh
node scripts/evals/prepare-stats-evals.mjs /tmp/new-stats-eval \
  /path/to/max/node_modules/@leemour/cli-messaging \
  /path/to/tg/node_modules/@leemour/cli-messaging \
  /path/to/max/skills/max-cli/SKILL.md /path/to/tg/skills/tg-cli/SKILL.md \
  --clock 2026-10-08T12:00:00Z --seed stats-v2 --repeats 2 \
  --interfaces cli,native-mcp
```

Use `mcp` for the shell proxy and `native-mcp` for Codex's attached stdio tools. Those interfaces
are recorded separately. Add `adversarial` for the three evidence-injection/bot/date tasks;
`--only 1,3` selects task numbers. `--grouped` preserves the earlier multi-task procedure and must
be reported as correlated contexts. Each repeat owns its own store and denied-profile store.

The manifest records clock/seed, dataset variant, fixture/rubric/skill/prompt hashes, SDK pins and
context identities. The fixture refuses mismatched clock/seed reuse. Keep its source unchanged
until the run ends; preparation/launch hash checks reject an edited fixture or oracle.

## Run an explicit model

The runner requires `--model`; it never silently takes an unknown default. It records the requested
model ID, Codex version, Node version, reasoning setting, argv, dates, duration and trial outcome.
The backend's immutable weight snapshot is not exposed by these events, so it remains null.
Even the same requested model ID and fixed fixture do not guarantee identical model output.

```sh
node scripts/evals/run-stats-evals.mjs /tmp/new-stats-eval \
  --model gpt-6.1-sol --reasoning low --concurrency 2 --timeoutSeconds 480
node scripts/evals/assess-stats-trials.mjs /tmp/new-stats-eval
```

The model name is an example, not a claim that it is enabled for every account. Existing Codex
subscription authentication is used without copying or inspecting credentials. User config is
skipped, default deny rules remain active, and owner MCP servers are not loaded. These model runs
consume usage. The runner uses the documented [noninteractive interface](https://learn.chatgpt.com/docs/non-interactive-mode)
and [MCP configuration](https://learn.chatgpt.com/docs/config-file/config-reference).

Only the two explicitly configured synthetic MCP servers use `default_tools_approval_mode="approve"`.
This trusts the local fake adapter for the requested eval; no owner configuration is changed.
With `auto` and approval policy `never`, native write calls—including a counter dry-run—can be
refused by the host before reaching the fixture. Preserve those trials as integration/setup
failures, and record a separately prepared rerun; never relabel them as command successes.
The denied fixture's command permissions still refuse refresh when host trust allows dispatch.

Trials have deadlines, process groups owned by the runner, event/diagnostic files and final answers.
A timed-out child is stopped by its recorded PID/group. Existing trial results are never overwritten:
prepare a new root for a rerun. Runner exit success establishes completion, not correctness.

## Assess and preserve evidence

The assessor checks task-specific outputs, counter-fetch scope, denied-profile refusal, call budget,
foreign tools and forbidden operations. It distinguishes blocked host setup from actual command
results. Prior permitted discovery reads may connect the fake adapter; denied refresh must make
no counter fetch. A reviewer must separately inspect every final answer and suspicious shell/event
trace against the registered rubric. A trace pass is not a final-answer grade or self-certification.

Prompt-level source/read restrictions are audited; the filesystem is not a hardened read boundary.
No source, oracle, database, owner file or credentials may be inspected by evaluated subjects.
Only public skill reads, fixture tools/helpers and in-memory parsing of synthetic output are allowed.
Preserve first failures and exact prompts, SDK/model identifiers, clock/seed, source revisions,
synthetic ledgers, events, final answers and raw assessments. Do not write owner content to evidence.

Serialized-result bytes include duplicated MCP text/structured envelopes; they are not wire traffic
or a causal efficiency measure. Aggregate by provider, interface and task, retain both repeat outcomes
and give denominators. Small repeated synthetic samples do not prove live adapter correctness,
general safety, a reliability percentage or behavior under other models.
