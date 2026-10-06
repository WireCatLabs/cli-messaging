# Model gateway

Status: implementation merged in #622 on 2026-10-06; initial publication 0.154.0.
Source baseline: `6471d01`. No store migration. Shared module, exported as `./models`.

Implement provider-neutral requests, adapters for OpenAI-compatible endpoints and Anthropic,
strict adapter-owned options and an injectable adapter registry for tests. Require purpose consent
before resolving keys or making requests. With no provider set, no network or key lookup happens.
Messages are supplied as data, never template variables or instructions. Errors must not expose
provider bodies, prompts or credentials. Preserve existing conversation analysis behavior and tests.

Resolve `models.<purpose>.provider|model|baseUrl` by field from the config layers, falling back
to `models.default`; explicit off disables a purpose. Existing analysis settings remain usable.
Support dotted config edits and report resolved field sources in config show.
Custom endpoint keys stay separate from public provider keys.

Required checks: lint, typecheck, test:coverage, docs:check. Fake adapters/fetch prove disabled
purposes, missing consent and invalid provider options cannot send. Consumer adoption follows a
published release; Liquid and reply-purpose consent follow in a separate PR.
