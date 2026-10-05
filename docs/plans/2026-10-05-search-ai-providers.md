# Configured search AI providers (SR-10)

Owner assigned the provider handoff on 2026-10-05. Add flat profile settings `embeddingProvider`, `embeddingModel`, `embeddingBaseUrl`, `embeddingDims`, `analysisProvider`, `analysisModel`, `analysisBaseUrl`. Default remains local e5-small and owner-agent analysis; explicit flags outrank settings. Models are explicit for hosted analysis, avoiding hidden model/cost choices. Validate endpoint URLs (HTTP/S, no credentials, query or fragment), providers, nonempty model IDs and dimensions. Resolve settings through the normal layers and source reporting.

Reuse embedding credentials with Anthropic support; base-URL credentials are keyed to their endpoint host, never inherited from the public OpenAI key. Use the official Anthropic SDK in a separate adapter and OpenAI-compatible chat completions in another. No provider tools, message text is untrusted data, errors never contain remote bodies or keys.

`conversations build --analyze --chat ...` opts into the configured provider. Reuse batch status/next/addAnswers and the shipped linking skill as the prompt source. Validate model output and batch IDs before the existing atomic write; rebuild after successful batches. Cap total input/output token exposure per run with conservative request reservation and reported usage; expose remaining work on budget exhaustion. No automatic retries.

Consent is remembered per account/chat/provider endpoint in account sync state (no migration); endpoint paths distinguish separate proxies on one host. List/revoke with `conversations consents`. A remembered yes is not a global yes; embeddings continue to ask each run. Local permission gates apply before writes and consent, including revocation. Machine mode requires --yes on first consent. Defaults never trigger analysis calls.

Test config validation and sources, flag precedence, credential isolation, both fake HTTP API shapes, malformed/truncated answers and atomicity, batch bounds/budget, remembered consent across chat/provider/revocation. Add docs/changelog and planned parity rows. Complete lint/typecheck/coverage/docs checks, PR and green merge; no SDK publication or consumer bump.
