# Reply rules editing commands

Status: approved by the owner on 2026-10-06; 🚧 `feat/replies-edit`.
Implementation follows the approved private handoff and editing plan. No store migration.

Add local `replies add|edit|on|off` and `replies audience`. New rules contain every default
key and stay off. An enabled rule that replies requires a nonempty template; disabled and
task-only rules may have an empty template. Validate the existing file and the full proposed
file before writing; preserve testers, other rules, their order, and the separate reply state.
Keep hours and limits in their original JSON input forms rather than writing parsed runtime
objects. Audience editing replaces named lists; deny still wins, testers still limit answers.

Commands use the profile's config directory, never connect or send, and publish no MCP editor.
Every command and option gets a parity row planned for each CLI's next shared-package bump.
Tests drive every option through an isolated CLI, including refusal without changing the file,
boolean inverses, empty lists, hours, large string ids, and stdout/stderr separation.
Required checks: lint, typecheck, test:coverage, docs:check.

The model gateway and Liquid templates follow in separate PRs; consumer adoption follows
publication with exact pins and each CLI's tests, matrix, generated help and user pages.
