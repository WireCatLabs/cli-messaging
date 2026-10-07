# Attachment OCR contract

Owner approved2026-10-07. Naming contract merged in PR677; default-agent instructions
merged in MAX449/TG323. Runtime implemented by `feat/attachment-ocr-runtime`, with
synthetic gateway/renderer/SQLite tests; publication and consumer adoption follow.

## Default agent path

An agent normally reads downloaded scans/photos with its own vision/document tools,
then writes literal transcription through `attachments text set`. `attachments list
--needs-text` supplies localPath, message locator and 1-based attachment number.
The text is kept in the existing attachment index and `content:` finds its message.
If a remote agent cannot access localPath, the path does not transfer the file; it
must report that limitation. No automatic API fallback or bundled OCR model.

## Explicit bulk API path

`attachments extract --ocr` explicitly permits sending image/scanned PDF content to
the configured `models.ocr` target through the shared model gateway. Plain text,
DOCX and useful PDF text layers remain local first. `--concurrency <n>` reuses the
existing meaning: simultaneous remote requests, default4, accepted1–8; without
`--ocr`, this option is rejected. Neither flag is added automatically by agents.
Existing chat/from-dir/download/output-dir/limit/cursor scope remains applicable.
API runs default to100files and500candidates per scan; --limit accepts1–500.
Use cursor for continuation; failed files remain unindexed and can be retried on
a later pass, while completed files reuse their hash/target cache.
`--offline --ocr` is rejected before downloads or model calls.

MCP execution uses the same command service, with `ocr` and `concurrency` inputs;
the operation has external effects only when explicitly selected. Consent is the
explicit OCR request and normal profile permissions, not reply-model consent.
Do not borrow a persistent chat consent from another model purpose.

Gateway gains validated local image inputs; OpenAI/Anthropic serializers remain
inside their adapters. Existing text callers remain compatible. Configure a
vision-capable target; an arbitrary compatible endpoint is not guaranteed to
accept images. Provider failure leaves good indexed text intact.

Images are locally validated/converted to supported formats and bounded by bytes
and dimensions. Scanned PDFs use optional local rendering, at most20pages, bounded
output pixels/bytes and8192output tokens per page. Unsupported input remains for
the agent. No silent page truncation or incomplete text marked complete. Preserve
page order, original language and literal text; ignore document instructions.

Bulk scheduling caps simultaneous file/page requests at concurrency, allows one
page per file at a time, and preserves bounded cursor scans. Cache completed text
by file hash plus OCR pipeline/target identity; empty local PDF extraction must not
block API OCR. Failed/incomplete files remain resumable without overwriting good
text. Agent-origin text is never overwritten by automated extraction.

Keep complete results atomically in the existing attachment_texts/attachment_words
index with OCR provider/model/version provenance, not a second database. Return
locators, local paths, counts/statuses and failures, never transcription or secrets
in run logs. `attachments text set` remains the agent ingestion command.

## Implementation checks

Synthetic gateway requests for both provider formats, invalid images, consent
before network, incomplete responses and cancellation. Synthetic images/PDFs test
bounded page rendering, concurrent requests, ordering, resume/hash/target invalidation,
agent text protection, failure preserving good text and account isolation. Both
agent write-back and API OCR must yield content: search hits in real SQLite.
No paid API evaluation or real-account request is needed for ordinary tests.
Image/PDF quality is not measured by these synthetic tests. JSON items retain
attachment order; JSONL reports file completions as they arrive. On provider429,
later API calls in that run stop without retry; per-file errors are sanitized.

References checked2026-10-07: [OpenAI image inputs](https://developers.openai.com/api/docs/guides/images-vision),
[Anthropic vision](https://platform.claude.com/docs/en/build-with-claude/vision),
[unpdf rendering](https://github.com/unjs/unpdf). Exact optional renderer support
must be verified before choosing the implementation engine.
