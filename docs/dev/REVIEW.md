# Reviewing a pull request in tg, max or here

The checklist a reviewer runs on every pull request in cli-messaging, tg-cli and max-cli — a person
or a reviewer agent given this page. Its rules are in [STANDARD.md](STANDARD.md); this page is how
to check them. Paste the verdict into the pull request: each line passed, failed with the reason,
or not applicable.

## A. A docs pull request — before any code

A new command, option or output change starts here and merges before its code.

1. **Names.** The command is `<resource> <verb>` with a verb from the list, the arguments have the
   fixed names, and nothing is an alias ([Command names](STANDARD.md#command-names)). A new verb or
   option name also has the owner's yes in the pull request.
2. **Options.** Each option is in the [catalogue](STANDARD.md#option-catalogue) with one meaning; a
   new one is added to `parity.json` with its value, meaning and default, and `pnpm parity:render`
   was run.
3. **Output.** A list answers the envelope, a write its `operationId`, an error one JSON object on
   stderr with a code from the table ([Output](STANDARD.md#output)).
4. **MCP.** The tool's name, its snake_case arguments, `readOnlyHint` and the permission flag it
   needs ([MCP](STANDARD.md#mcp)).
5. **Both CLIs' pages.** The user page of each CLI says the same thing at the same depth, max's in
   Russian and tg's in English ([Documents](STANDARD.md#documents)).
6. **Manifest row.** `parity.json` has the command and its options as `planned`, with who builds them.

## B. A code pull request

1. **Layers.** The command and the MCP tool call one service method; the service calls a port group;
   no command calls an adapter method for a use case a service owns, and no messenger type crosses
   the adapter ([Layers and sharing](STANDARD.md#layers-and-sharing)).
2. **Shared by default.** Code that names no messenger is here, in cli-messaging, not in a CLI. A
   CLI-local feature is one the other messenger cannot have, and the manifest row says why.
3. **Parity.** The manifest row flips from `planned` to `both` (or one-sided with a reason) in the
   next cli-messaging release; `pnpm parity:check` is green in the CLI.
4. **Tests.** A test drives the new behaviour through the command, and a failure path is tested;
   max-cli's test matrix lists every new command and option.
5. **Changelog.** An entry under `## Unreleased` with the fixed headings, saying what changed for a
   user or a caller and what to do if it breaks them; no internal ids.
6. **Safety.** Nothing sends, marks read or deletes unless the command asked for it; in machine
   mode stdout carries data alone; the process exits on every path; no message, token or phone
   number reaches a log, a fixture or a document.
