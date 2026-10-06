# Search extraction, local catch-up and archive gaps

Approved2026-10-07; interfaces in STANDARD's search-preparation section.

Implement in three independent feature PRs, each based on current main:

1. Extend shared attachment extraction with safely matched directory files and exact message/file
   selection. Add MCP extraction and download --extract; preserve output without the new flag.
   Check hashes so same-size replacements are not skipped, and preserve agent-origin text.
2. Purge edited-away vector hashes while retaining genuine shared users. Reuse local graph/vector
   preparation after fetch only when enabled, with message/chunk/time/abort bounds, atomic build
   publication, background-job parity and structured partial progress.
3. Add local gap planning from recorded inclusive ranges and bounded repair using existing fetch
   pagination/jobs/leases. Respect id/time ordering, ambiguous timestamp boundaries, concurrent
   ingestion and re-check; never infer missing messages from ID holes or delete by absence.

Default preparation is off;500chunks/10,000messages/30seconds when enabled. Gap repair defaults
to5interior gaps/500messages/30seconds. No remote model calls or automatic model downloads.
Existing store schema is reused; claim a migration first if an implementation proves it necessary.

Synthetic regression tests cover service/CLI/MCP discovery and call behaviour, permissions before
file/network work, account/chat isolation, directory ambiguity and escapes, optional engines,
changed bytes, shared hashes, abort/atomicity, job resume and coverage truthfulness. Run mandatory
lint/types/coverage/docs/matrix/Bun and publish the SDK before exact-pin consumer adoption.
Real-account checks, consumer npm releases and site publishing are separate scopes.
