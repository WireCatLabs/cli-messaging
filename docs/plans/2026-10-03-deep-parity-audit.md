# Detailed parity audit automation

Status: approved scope from the owner's request to automate the detailed parity skill. Claimed by `feat/deep-parity-audit`; skill consumer claim `docs/parity-audit-automation` in max-cli.

The current script (`scripts/parity-audit.ts:27,99,165`) checks the manifest and gathers only MCP names. `src/parity/audit.ts:120` renders counts and page headings. Neither measures direct arguments/defaults, schema/annotations, configured visibility, source registrations, or fresh coverage. Recent detailed measurements exposed these gaps without account access.

Implement a deep mode alongside the existing surface command. One run clones pinned main snapshots or accepts explicit clean worktrees, builds them, captures all commands and MCP schemas in disposable homes, gathers source registration/import evidence, runs coverage plus repository gates/matrices, and executes common synthetic search/read scenarios. Output a JSON evidence bundle and exhaustive Markdown appendices, including failures/skips and snapshot movement. Never infer semantic equality from names, percentages, source imports, or provider labels.

Pure generic comparison/rendering belongs in src/parity with regression tests; process/filesystem/source-analysis orchestration in scripts. Host-specific fixture setup is separate from generic comparison. Preserve existing parity:audit stdout behaviour unless deep mode is requested. The MAX skill routes to deep mode and describes the human review still needed for protocol reasons, owned debt and live evidence.

Validation: changed arguments/defaults/aliases vs help-only diffs; schema required/enum/additionalProperties/order and annotations; nested commands; missing/failed checks; source evidence; synthetic CLI/MCP split framing and clean exit; full fresh deep run on both real repositories without accounts. Repository lint/typecheck/coverage/docs/build/Bun, and MAX's required gates for the skill update. No account tests, releases or install of user binaries. Retain temp paths for cleanup.
