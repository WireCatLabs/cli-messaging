# Independent statistics evaluations

The fixture drives real shared CLI commands and an actual modern MCP server/client in memory.
Remote operations use a synthetic adapter. It never loads a native messenger adapter, account login,
keyring or network transport. Every database/config/cache path belongs to the chosen temporary root.
MCP is reached through a shell proxy; this does not measure native model MCP integration.

Run the transport/seed/write/cursor smoke before evaluating a model:

```sh
pnpm build
node scripts/evals/smoke-stats-evals.mjs
```

Prepare four fresh contexts using the SDK directories pinned by your MAX/TG candidates and their
public skill files. Use an absent destination directory. The subject directories must contain their
installed dependencies. Expected answers stay outside the evaluated working directories.

```sh
node scripts/evals/prepare-stats-evals.mjs /tmp/new-stats-eval \
  /path/to/max/node_modules/@leemour/cli-messaging \
  /path/to/tg/node_modules/@leemour/cli-messaging \
  /path/to/max/skills/max-cli/SKILL.md /path/to/tg/skills/tg-cli/SKILL.md
```

Add `adversarial` as a final argument for two focused contexts: MAX CLI and Telegram MCP.
These expose an attack inside requested evidence, bot/channel replies, and an answer outside the
root question date. Register the rubric before running, never give it to evaluated agents.

For each prepared context, invoke the installed Codex CLI from a fresh context. No model override
is implicit; record the actual model if the runner exposes it. Existing runner authentication is
used without copying or inspecting credentials. User config is skipped to avoid owner integrations.
Keep default deny rules. This command uses a subscription-backed runner and can incur usage.

```sh
codex exec --ignore-user-config --ephemeral --skip-git-repo-check \
  --sandbox workspace-write -c 'approval_policy="never"' \
  -C /tmp/new-stats-eval/max-cli --json \
  -o /tmp/new-stats-eval/max-cli/final.md - \
  < /tmp/new-stats-eval/max-cli/prompt.txt \
  > /tmp/new-stats-eval/max-cli/events.jsonl \
  2> /tmp/new-stats-eval/max-cli/runner.log
node scripts/evals/summarize-stats-evals.mjs /tmp/new-stats-eval \
  max-cli telegram-cli max-mcp telegram-mcp
```

The trace summary checks concrete outputs and action scope; a reviewer must separately grade final
answers and inspect runner events for prohibited reads or tools. Eight tasks share each context,
so they are correlated and do not form eight independent statistical samples. Only public skill
reads, wrappers and in-memory parsing of synthetic output are allowed. These are prompt-level
restrictions, not a hardened read-isolation boundary; audit violations invalidate a run.

Preserve prompts, exact fixture/skill hashes, source SHAs, subject pins, seeds, rubric, first failures,
final answers and synthetic traces. `serializedResultBytes` counts the serialized fixture result,
including duplicated MCP structured/text envelopes; it is not network traffic or comparable causal
CLI/MCP efficiency. Helper calls count against the agent budget but have no result-byte entry.
No owner messages, sessions, tokens or credentials belong in evidence. Never silently replace a
failed trial with a successful rerun. The dated public report records assessed results and limits.
