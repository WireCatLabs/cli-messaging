# Liquid reply templates

Status: approved by the owner on 2026-10-06; 🚧 `feat/reply-liquid`.
Requires the model gateway and rule editor PRs on main before opening this implementation PR.
Renderer pinned to LiquidJS 10.30.0; validate its documented limits in installed-version tests.
No store migration; keep `Replied` as sent/skip variants.

Add strict Liquid rendering with sender/chat facts and rule-zone time, no incoming message
variable, no filesystem includes, prototype access or unlimited rendering/allocation. Custom
async ai blocks render their instructions, use the gateway and replace only their own output.
An else branch is used on missing configuration, missing consent or model failure; without one
the reply is skipped with a content-free reason. Bound model calls and output length; refuse
verbatim echoes of incoming data. Consent is granted once per profile and provider endpoint,
with chat opt-outs and revocation checked on every request. Changing endpoints needs a new grant.

Preserve old placeholder files with warnings. Old may-reword files retain their literal behavior
until AI is explicitly configured and consented to: whole-template ai blocks have the original
filled template as fallback. Plain new templates have no model field. `replies test` previews
instructions/fallback without a model call; `--ai` opts into rendering through a consented model.
Serve retains tester, audience and permission gates before any model request; tasks still open.

Add local consent commands, parity rows for every new command/option, renderer/consent/CLI and
serve tests. Required checks: lint, typecheck, test:coverage, docs:check; consumer adoption only
after shared publication, including MAX's native Replier and openRequestTask integration.
