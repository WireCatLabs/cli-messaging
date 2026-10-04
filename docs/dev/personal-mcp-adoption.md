# Personal MCP factory adoption

Claim: `feat/personal-mcp-factories`, 2026-10-04. The owner requested MAX/Telegram MCP parity after the consumer releases. MAX adoption is on `feat/mcp-parity`; avoid a competing SDK export or catalogue fork.

Expose the shared personal MCP tool definitions and mounting seams through a public consumer API. Preserve the same catalogue used by Telegram, metadata permission keys, local-only callbacks, confirmation guards and transcription/embedding cleanup. Capabilities remain provider-specific: MAX has no forum topics. Update stale pre-P7 manifest wording from actual implementations.

Validate reuse and provider capability behavior with isolated tests, lint, typechecking, coverage, docs and Bun. Release the SDK prerequisite before the consumer pins it; no live account operations or model downloads.

Implementation completed in PRs #511 and #518. Consumers require published cli-messaging 0.144.0 or newer; MAX retains its session, provider previews and transcript cache.
