# CLI conventions and agent compatibility audit

**Status 2026-10-06: documentation and bounded local audit, not full certification.**
Shared source baseline `a60391a`, with the stats-standard documentation branch on top;
isolated probes ran at `e1daf47` (parent `b015f1d`), whose inspected shell/tool files are
unchanged from that baseline.
MAX `027b1b7` and Telegram `1903e3f` currently pin shared 0.149.0 and core 0.17.1.
The shared baseline is ahead of those installed consumer pins. Source findings must be checked
again at adoption; a change on shared main alone does not fix a published consumer.
No real session, keyring, messenger, browser login or account data was used.

## Scope and evidence

The [external adoption profile](STANDARD.md#external-references-and-our-adoption-profile) owns
the references and project policy. This page maps them to source and a work queue. It checks
representative shared entry points, MAX/TG integrations and existing synthetic tests; it does
not execute every command or run the third-party conformance kit. “Source-supported” means
the relevant implementation was read, not that every command passed a new end-to-end check.

The current POSIX page returned HTTP 403 to direct browsing. Its official indexed utility
conventions and rationale were checked; strict POSIX certification is neither assessed nor
claimed. GNU, CLIG, MCP, Agent Skills and the agent-oriented project pages were read directly
or through their official indexed content. Sources were consulted on the audit date.

### Conventional CLI behaviour

| Check | Evidence | Assessment / work needed |
|---|---|---|
| Help/version | `src/cli/program.ts:59`; synthetic help/version calls below | Observed exit 0, requested text on stdout, no stderr. No business action in the synthetic command. Audit consumer prepare/update hooks for filesystem/network purity separately. |
| End of options and global flag placement | Commander 15; synthetic calls below | `--` and global `--json` before/after a leaf work in the sample. No claim that every variadic/nested path handles every ordering. Add representative bot/profile/negative-id cases. |
| Consistent nesting | `docs/dev/STANDARD.md`, `src/cli/messenger/chats-command.ts:15` | Existing resource groups; new stats paths planned. Keep distinct reports as leaves and measures as options. Stats migration remains implementation work. |
| stdout/stderr separation | `src/cli/context.ts:40`, `src/cli/program.ts:264`, MAX `src/output.ts:28` | Shared/consumer renderers separate data and diagnostics; confirmed failure stdout is empty. Error serialization has the two gaps below. |
| Parser failure in machine mode | `src/cli/program.ts:149`, MAX `src/program.test.ts:226` | **Observed gap:** unknown option returns exit 1 and prose, even with `--json`. Convert parser usage errors to validation_error/2 with a single JSON error on stderr. Do not append help to the JSON stream. |
| Explicit JSON while a TTY is attached | `src/cli/program.ts:264` | **Observed gap:** a service validation error with `--json`, tty:true returns text. Error rendering currently keys off tty rather than explicit format. Make explicit JSON/JSONL take precedence, including failure hooks. |
| No interactive write confirmation in machine mode | `src/cli/messenger/ask.ts:47`, `:63` | Source-supported: refusal or explicitly supplied confirmation flag, no write-confirmation prompt. `--yes` authorizes the action; it must not disable guards. |
| No input / headless execution everywhere | `src/terminal/prompt.ts:30`, `src/cli/messenger/password.ts:16`, consumer login/setup commands | **Partial:** credentials may read stdin to EOF or prompt on a TTY. No global no-input switch in the shared program. Define one policy for setup/password/auth and machine mode, including harnesses that allocate a PTY. Never auto-launch a browser in that mode. |
| Colour and terminal effects | MAX `src/output.ts:29`, shared renderer in core; MAX `src/session/qr-terminal.ts:5` | Ordinary output selects JSON off-TTY and honours NO_COLOR for pretty output. QR intentionally forces contrast; keep that opt-in presentation exception explicit. No blanket ANSI-free claim for help/QR/trace. CI/TERM=dumb/forced-colour precedence needs targeted checks. |
| Input/output composition | `src/cli/messenger/stdin.ts:2`, `src/cli/bot/api.ts`, archive commands | Stdin and JSONL exist. readAll accumulates unrestricted input, without its own abort/byte budget. Add byte bounds/cancellation for buffered inputs; retain streaming for large exports. `-` is a command-specific convention, not supported by every operand. |
| Time bounds and cleanup | `src/cli/settings.ts:366`, `src/cli/messenger/patience.ts:4`, shared lifecycle tests; MAX `src/deadline.ts:37` | Whole-command timeout is optional: no default when not supplied. Existing tracked cleanup and signal paths are useful, but uniform SIGINT/SIGTERM/EPIPE behaviour and child cleanup need focused process checks. Bound stdin and setup too. Do not cap intended watch/serve sessions with a generic short deadline. |
| Backward compatibility | `docs/dev/STANDARD.md`, MAX no-alias regression tests | **Policy divergence:** immediate removal of renamed paths. CLIG recommends a documented deprecation process. Decide the transition policy before stats relocation; versioned breaking notes alone are not a deprecation window. |

### Agent-facing contracts

These are our implementation observations and proposed priorities, not an assertion that an
independent agent specification is an industry standard.

| Pattern | Evidence | Assessment / work needed |
|---|---|---|
| Scoped discovery | `src/cli/commands-command.ts:17`, `src/cli/commands-command.test.ts` | Present: one path per call, inherited options, tool version, contract number and exit table. No settings/store/session needed by the discovery action. Prefer this to loading the whole command tree into context. |
| Typed input and output discovery | `src/cli/commands-command.ts:44`, core `commands/index.js`; `src/mcp/tool.ts:217` | **Partial:** CLI flags/choices/defaults are described, MCP inputs are schemas. Most CLI commands do not publish input/output JSON Schemas, conditional constraints or per-command retry/effect metadata. Output schemas are not registered in the shared MCP tool definition. Add a shared contract model rather than another handwritten catalogue. |
| MCP results | `src/mcp/tool.ts:340`, `:344` | Shared object results include structuredContent and a JSON text block; tool failures set isError. MCP outputSchema is optional; its absence is a discovery opportunity, not itself a protocol violation. No complete SDK negotiation/transport audit in this scope. |
| Bounded useful results | `src/cli/settings.ts:18`, `src/cli/paging.ts`, `src/mcp/tool.ts:27` | Default row limits and hasMore exist. A row may contain very long text/context; there is no general serialized-byte/token cap or universal field projection. Add explicit limits and continuation/truncation metadata, without silently truncating a user's requested transcript/export. |
| Honest completeness/freshness | `src/services/messages-search.ts:174`, `src/services/search-refresh.ts:117` | Search coverage is present. New-message sync does not refresh old counters. Preserve unknown versus zero and distinguish snapshot freshness from held history coverage in ranking. |
| Preview of writes | Config/store/moderation commands have dry-run; message/admin writes have guards and operation ids | **Partial:** no general request preview for sends/deletes/admin mutations. Design a preview that resolves/validates the target and permission without taking a write reservation or sending; it must list any preparatory reads/local effects. Preview never guarantees the remote state will stay unchanged before execution. |
| Idempotency and retry | `src/sends/journal.ts:8`, `src/sends/guard.ts:226`, MAX `src/bot/transport.ts:218` | sendId and unknown-outcome bookkeeping exist. operationId correlates a write; it does not make arbitrary writes idempotent. Some errors expose retryable/retryAfterMs, but there is no uniform safe-retry contract. Never infer replay safety solely from exit status or transport timeout. |
| Trust and least authority | `src/mcp/tool.ts:38`, `:49`; shared permissions/guard; consumer SKILL.md | Read results carry a data-not-instructions warning and writes are guarded. MCP annotations are hints. Keep guards authoritative and exclude credentials/message content from diagnostics. Do not adopt examples that trust every env variable or bypass permissions by hiding tools alone. |
| Portable agent guidance | MAX/TG `skills/*/SKILL.md`, shared `skills/link-conversations/SKILL.md` | Skills already exist. Automate frontmatter/reference/version checks against discovery; assess whether large instruction bodies should move detail into references. Repository AGENTS.md is development guidance, not a substitute for the installed user skill. |
| Real agent evaluations | Synthetic command/service/MCP tests | Strong deterministic coverage is not evidence that an agent chooses the right command. Add a separate synthetic task benchmark for discovery, ambiguity, pagination, validation recovery and refusing replay of an unknown write outcome. Record correctness, calls and output bytes; do not use owner messages. |

## Additional references and applicability

[MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) is an actual
protocol specification, applicable to our MCP adapter. It provides schemas and structured tool
results; optional output schemas have additional obligations when advertised. It does not
standardize shell arguments or require our CLI responses to use JSON-RPC.

[Agent Skills](https://agentskills.io/specification) is a portable instruction-package
specification. Its progressive-loading model is relevant to keeping installed guidance focused;
it does not replace binary discovery, validation or permission enforcement.

[JSON Schema](https://json-schema.org/specification) gives input/result discovery a reusable
language with an explicit dialect. A schema must describe the JSON actually returned, including
string ids, nullable fields, errors and pagination; publishing internal TypeScript types alone
does not let an agent validate a command response. The dialect and versioning strategy still
need to be selected for the proposed CLI contract surface.

[Agent Client Protocol](https://agentclientprotocol.com/get-started/introduction) connects editors
and coding agents. It is outside this CLI's role: being callable by an agent does not require
implementing an editor-to-agent protocol.

[Anthropic's tool-design guide](https://www.anthropic.com/engineering/writing-tools-for-agents)
supports testing distinct, well-described tools on real tasks and controlling context cost.
Apply that to our existing CLI/MCP service boundary and scoped discovery. This is design
guidance, not a mandated command grammar or permission policy.

The [independent CLI Agent Spec requirements](https://cli-agent-spec.github.io/requirements/)
provide a broad checklist, including bounded execution, preview, schema discovery and trust
handling. Their specific envelope, exit table and non-TTY help routing conflict with existing
contracts. Evaluate requirements individually; do not claim Level 1/2/3, change error numbers,
or add schema-version fields to every result just to match the checklist. Its
[conformance kit](https://cli-agent-spec.github.io/conformance/) was researched, not executed.

[Google Workspace CLI](https://github.com/googleworkspace/cli) documents schema lookup and
request previews; its [agent context](https://github.com/googleworkspace/cli/blob/main/CONTEXT.md)
uses response field masks. It is a concrete open-source project and explicitly not an officially
supported Google product. We can apply the pattern without adopting its dynamic API tree or
overloading our output flag to mean JSON input. Its implementation was not installed or exercised
in this audit; the example rests on the project's own documentation.

## Isolated observations

After building shared code, a synthetic app used the public run() shell with only `probe` and
`fail` commands, injected captured streams, disabled run recording/skill hints and temporary
config/state/cache/store paths. `fail` threw CliError(validation_error, synthetic failure).
No service or network adapter was constructed. The configuration resolver was a fixture.

| Arguments | TTY | Exit | stdout | stderr |
|---|---|---|---|---|
| `--help` | false | 0 | Text help | Empty |
| `--version` | false | 0 | `1.0.0` | Empty |
| `probe --unknown --json` | false | 1 | Empty | Unknown-option text |
| `fail --json` | true | 2 | Empty | Human error text |
| `fail --json` | false | 2 | Empty | JSON error |
| `probe -- -synthetic` | false | 0 | Empty | Empty |
| `--json probe` and `probe --json` | false | 0 | Empty | Empty |

These observations isolate parser/error routing. They do not measure MAX/Telegram network
behaviour, guarantee all commands are pure on help, or prove every non-interactive path exits.
Existing shared/consumer tests corroborate the same parsing and lifecycle boundaries.

## Ordered work queue

1. **Machine error consistency.** One shared conversion of Commander errors and explicit-format
   failure rendering, preserving requested help/version as successful text. Add unknown command,
   option, missing operand/value and TTY+JSON tests; consumer adoption and breaking notes for exit 2.
2. **Headless and execution bounds.** Naming/contract for explicit no-input, password/auth/setup
   alternatives, buffered stdin budgets and finite one-shot deadlines. Test synthetic PTY/pipe,
   open stdin, abort, SIGINT/SIGTERM and EPIPE. Interactive login/watch/serve need documented exceptions.
3. **Stats compatibility decision.** Choose immediate breaking relocation or a deprecation window
   with explicit compatibility routes and permissions. Do not implement both contradictory rules.
4. **Schema and effect discovery.** Extend the shared command contract with input/result schemas,
   conditional arguments, read/local/network effects and retry policy; reuse for CLI discovery/MCP.
   Preserve existing response shapes; version discovery independently where necessary.
5. **Bounded output and previews.** Establish row/body/serialized-byte limits and continuation,
   selectable compact projections and read-only previews for sensitive writes. Announce option
   names before implementation; never silently crop output or reserve a real write during preview.
6. **Agent guidance and evaluations.** Validate skills against the binary and run a synthetic agent
   task suite. Promote a pattern only if its benefit and behaviour are measured.

This queue is an implementation proposal, not completed remediation. Runtime changes, shared
publication, exact consumer adoption and any approved live checks remain separate work.
