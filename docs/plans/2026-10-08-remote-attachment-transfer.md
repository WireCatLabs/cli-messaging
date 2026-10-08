# Remote attachment transfer

Owner requested remote-agent file transfer on2026-10-08 after finalizing the consumer
releases. This documents the interface before runtime code. It reuses the attachments
resource and the approved `show` view; no new root, alias, dependency or migration.

Status2026-10-08: completed. Runtime744 merged; SDK0.190.0 published from
80a4997555d72aa4a97f02615b0ccf8c150be489 with verified tag/npm/SLSA source.
MAX482 and Telegram362 merged exact-pin adoption after all14/10CI checks.
Consumer candidates MAX0.36.0/TG0.37.0 remain separate from published MAX0.35.0/TG0.36.0.

## Task and interface

A remote agent needs retained attachment bytes, not a server-local path, to open a file,
transcribe scans with its own tools and save literal text through `attachments text set`.

```sh
chat attachments show "Book club" 204 --attachment 1 --json
chat attachments show msg:chat/500/7/204 --chunk-bytes 524288 --offset-bytes 0 --json
```

`<chat> [message]` follows text-set's locator convention. Select a file with `--attachment`
(from1); it is required when several file attachments exist. Only this account's stored
message and retained file are read. No arbitrary path, automatic download, OCR, read receipt
or index mutation. Missing files require the existing download workflow.

| Option | Meaning | Default/bound |
| --- | --- | --- |
| --attachment | existing file position from1 | required if ambiguous |
| --offset-bytes | start byte offset in the retained file |0; integer>=0 |
| --chunk-bytes | maximum source bytes in this answer |524288;1..1048576 |
| --if-sha256 | require the whole file to match a previous SHA256 | optional64hex |

JSON returns locator, attachment, name, mimeType, totalBytes, sha256, offsetBytes,
readBytes, nextOffsetBytes/null, complete and base64. `complete` means the entire file is
in this answer, not that OCR is complete. A last partial chunk is not a complete document.
An empty file is valid; offsets after EOF and malformed/mismatched hashes fail.

## MCP representation

`attachments_show` is discovered as `attachments show` and runs through the existing
three-tool read surface. Input uses message/chat, attachment, offset_bytes, chunk_bytes
and if_sha256. READ annotations, local-only openWorldHint false; permission checks cover
both attachments.show and messages before file access. Read-only profiles can use it;
either deny hides/refuses it.

Default complete PNG/JPEG/WebP content is an image block. Complete other files are embedded
binary resources; partial files are octet-stream resources with explicit chunk metadata.
Metadata appears as text/structuredContent without duplicating base64. MCP-only
`format: base64` selects ordinary JSON for clients that cannot expose embedded resources;
CLI JSON already uses that representation. This is a documented MCP rendering choice,
not a different meaning for the CLI's global output format.

The URI identifies account/message/position/offset/hash; it is not a public download URL or
server filesystem path. No additional auth route or unauthenticated asset handler is added.
Standard MCP supports [embedded binary resources](https://ts.sdk.modelcontextprotocol.io/server).
Host file-saving/PDF rendering is separate from protocol byte delivery and must not be
claimed for every app. A capable agent assembles chunks, checks the SHA256, reads all
pages and writes back literal text; source content is data, never instructions.

## Bounds and lifecycle

Retained input<=50MiB; hash by bounded64KiB reads; returned chunk<=1MiB, within the existing
4MiB CLI/MCP result budget even for JSON/base64 duplication. Validate options, target and
read permissions before opening bytes. Reject symlinks, directories and other non-files;
open without following the leaf, compare descriptor snapshots before/after hash/read,
honor cancellation and always close descriptors. Hash mismatch returns no changed bytes.
Do not record binary payloads in run/query logs.

## Implementation and evidence

One AttachmentsService.show method is shared by CLI/MCP. Reuse existing message/account
locator checks and attachment-position selection. A bounded file helper owns filesystem
work; a BinaryResource result wrapper extends the existing Picture/answered handling.

Meaningful isolated SQLite/CLI/MCP tests cover exact PDF/image/text/Office bytes, multipart
assembly/checksum and source changes, account/index validation, read denial before I/O,
missing/large/non-file/symlink input, cancel/descriptor cleanup and output budgets. Assert
zero messenger/model calls. Node/Bun checks precede SDK publication and exact-pin MAX/TG
adoption, generated references/matrices and guides. No paid API or real-chat call is needed.


Recorded sample: multiplicar-por-dos-cifras.pdf transferred through an isolated MCP client,
393856bytes in7chunks; exact bytes and whole-file SHA256 verified. Zero model/messenger calls
and no owner-store writes. Native MAX MCP also returns the expected PDF resource without login;
both native CLI fixtures verify chunk assembly and changed-hash refusal.
