# Lightweight attachment readers

Owner approved2026-10-08; claimed `feat/attachment-readers` before implementation.
Digital document text uses the existing attachment index, permissions and ingestion path.
No new command, model purpose or migration. Scan/image OCR remains agent-first, with API
only through explicit --ocr; locally readable documents never go to that model.

## Scope

- UTF-8 first, BOM-marked UTF-16LE/BE, then bounded statistical legacy encoding detection.
  Sample at most65,536bytes across the file; require confidence80 and a15point margin.
  Uncertain short data, invalid sequences, binary controls and UTF-32 remain unreadable.
  Source bytes are not rewritten. Provenance records non-UTF8 encoding.
- ODT paragraphs and headings, explicit spaces/tabs/line breaks.
- ODS named sheets, cell coordinates and saved values, bounded repeated rows/cells.
- XLSX workbook order, named sheets, cell references, shared/inline strings and saved values.
- PPTX presentation order and text runs, including soft line breaks.
- EPUB OPF spine order and XHTML body text; scripts/style/head metadata are excluded.

Formulas are retained as labelled source formulas, not executed. Images/charts/macros,
precise rendering, old binary DOC/XLS/PPT, RTF, DRM/encryption and generic ZIP recursion
are outside this reader. Existing unpdf/mammoth/canvas engines remain optional.

## Bounds and integrity

Input50MiB, expanded ZIP50MiB, XML/HTML part10MiB,1000entries, XML depth128 and200,000
markup nodes; output2million characters. Structured output over its limit fails instead
of silently truncating. Stream1KiB compressed chunks, enforce actual expanded bytes,
verify CRC and central/local metadata, reject duplicate/unsafe paths and missing parts.
Only archive-memory references are resolved; no filesystem extraction or external entity
fetch. Bounded event-loop yields allow cancellation before index write.

Failed local reads may retry at the same hash; completed readers cache hash plus current
reader identity. Agent text is never overwritten, including races. A failed extraction
also cannot erase earlier good automatic text, enforced atomically in the existing store.
Account boundaries and the existing content: search index are unchanged.

## Dependency budget and runtimes

Pinned chardet2.2.0, fflate0.8.3, @xmldom/xmldom0.9.12 and iconv-lite0.7.3 with safer-buffer2.1.2:
1,802,446bytes (~1.72MiB) unpacked, no native binaries or local model. The fallback is
needed because Bun1.3.14 lacks native windows-1251 decoding; Node keeps its native decoder
where available. Node tests and the checked-in Bun smoke exercise legacy text and all
five formats. Package size is not a document processing memory measurement.

## Verification and adoption

Synthetic independent stored-ZIP and DEFLATE fixtures, metadata order differing from
entry order, Unicode/strict namespaces, missing parts, cached formulas, repeated ranges,
CRC corruption, encrypted flags, DTDs, traversal, limits and cancellation. Real SQLite
checks content: hits, protected text, hash/reader cache, failure retry and account isolation.
No paid model or real-account request is needed. SDK release and exact-pin MAX/TG adoption
follow green checks; consumer documentation then describes the adopted version.
