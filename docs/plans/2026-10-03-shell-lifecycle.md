# Shared program lifecycle

Status: approved consumer migration plan, 2026-10-03. Claimed by
`feat/shared-shell-lifecycle`. This slice owns `src/cli/program.ts`, its tests and shell docs;
max-cli's command/cache migration remains with its existing workstream.

## Goal and evidence

max-cli still implements its own create/run shell; tg-cli delegates to this package.
At max-cli `6bd9032`, `src/program.ts:105` adds server flags, `:178` injects the legacy command
context and `:225` settles a bot command's recording when its action throws. These are the
consumer-specific seams needed before it can adopt this package's shell. The shared shell
already owns parsing, profile lifting, errors and fallback recording (`src/cli/program.ts:38,90`).

## Contract

Optional `ProgramDefinition.configure(program)` runs after command registration, before recursive
output wiring. It can add provider options or command hooks. Optional `prepare(program, environment)`
runs before parsing, with the same effective streams and app identity supplied to shared commands;
legacy commands can receive their own context without reimplementing run.

Optional `onFailure(error, program)` settles consumer-owned recording before shared fallback
recording. It is awaited only for failures, including preparation errors; help/version successful
Commander exits do not invoke it. An already settled failure is not recorded twice. If the hook
itself fails, the original error and exit code remain authoritative and stderr names the failed
handler without copying its potentially private error text.

Existing definitions omit the hooks and retain their behavior. This adds no commands, manifest
rows, protocol calls, provider branches or store migrations. Consumer adoption is a separate PR
and release; tests here use only synthetic commands in the repository sandbox.

## Work and validation

1. Add the optional lifecycle seams, retaining shared error handling and environment injection.
2. Test local option/profile parsing, legacy context, preparation errors, awaited failure settlement,
   no duplicate recording, help/version, handler failure and both consumers' basic machine contract.
3. Run lint, typecheck, coverage, docs checks and build; publish the shared exports through the normal
   release workflow before a consumer adopts them. Recheck current max-cli ownership before adoption.
