# Remote PDF page preview

The owner requested remote-agent file reading. Their actual ChatGPT Work test retrieved all393856bytes and verified the fixture SHA256 but could not move MCP binary data into its PDF renderer. Four pages were counted structurally, not visually. No recognized text was indexed. Empty scoped searches had unknown coverage and do not establish absence.

Implement an explicit `attachments show --page N` / MCP `page` option in the shared service and adapters. Render one retained PDF page locally with the existing optional unpdf/canvas engines and return standard MCP image content. This is rendering, not API OCR or automatic indexing. The agent reads all pages and explicitly writes text. Keep ordinary byte transfer unchanged.

Base46c94da (shared0.205). Existing paths: src/attachments/transfer.ts for no-follow bounded retained reads; src/services/attachments.ts for scoped file selection; src/attachments/ocr.ts for existing optional renderer; src/mcp/tools/attachments.ts for image outputs; src/cli/messenger/attachments-command.ts for CLI options.

Preserve account/message/file permissions, no-follow and source hash checks. Reject page/chunk combinations, non-PDF sources, missing engines, malformed files and out-of-range pages. Bound input50MiB, document20pages, image dimensions2000pixels and output1MiB. Return source hash/size separately from preview image hash/size. Never connect to a provider or store text during preview. Always clean up renderer state on success, failure and cancellation.

Verify bounded reads, renderer failures/limits/cleanup, CLI and MCP page images with isolated synthetic PDFs and permissions. Run lint/types/full coverage/docs. Then open a PR and retest the existing fixture through a labelled development build. Do not claim the actual hosted OCR pass until the user supplies evidence. Native adoption and public guides follow the shared change; no owner index is involved.
