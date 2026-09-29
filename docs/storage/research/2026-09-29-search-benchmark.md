# Search benchmark at 100k and 1M — SQLite FTS5, PGlite, native Postgres

2026-09-29. Full numbers, settings, query plans and how to rerun:
[`../../../bench/search/results.md`](../../../bench/search/results.md); scripts beside it
(`gen.ts`, `sqlite.ts`, `pglite.ts`, `run.sh`). Synthetic corpus: ~200 chats (one with 50%), ~5k
senders, 3 sources, 3 years, 5–40 words of mixed Russian, Spanish and English, target words planted
at known frequencies with a ground-truth file.

## Engines as set up

- **SQLite** — `node:sqlite`, `text` + `normalized_text` (NFKC, lowercase, diacritics stripped,
  ё→е); btree on (chat, date), sender, source; FTS5 external content, `unicode61`, `bm25()`; fuzzy =
  vocabulary from `fts5vocab` + trigram lookup + Damerau-Levenshtein ≤ 2 in JS, then FTS5 with the
  corrected terms. The query joins with `CROSS JOIN` so the text is searched first — a plain `JOIN`
  picked a plan running `MATCH` per row, 199 ms at 100k.
- **PGlite 0.5.8** — COPY load, indexes after, `maintenance_work_mem` 256 MB; BM25 through
  `@electric-sql/pglite-pg_textsearch` (`simple` config); fuzzy through `pg_trgm` on a vocabulary
  table.
- **Postgres in Docker** — same schema, newer pg_textsearch; the reference for "is it WASM".

## 1M messages, p95 ms, 20 runs

| Query | SQLite, all words | SQLite, any word | PGlite, any word | Postgres, any word |
|---|---|---|---|---|
| 2 rare words (~1%), all chats | 1.6 | 42 | 2.5 | 1.1 |
| same, big chat (500k) | 1.3 | 39 | 10.5 | 1.9 |
| same, small chat (2k) | 0.7 | 26 | 80 | 46 |
| same, one sender | 1.0 | 31 | 39 | 20 |
| 2 common words (5–15%), all | 24.5 | 187 | 4.2 | 3.3 |
| same, small chat | 16.2 | 109 | **298** | **150** |
| same, one sender | 15.9 | 102 | 86 | 27 |
| same, big chat + last 90 days | 17.9 | 115 | 107 | 65 |
| fuzzy, worst of 4 typos | 15.0 | | 3.7 | 3.5 |
| «València» / «счёт» | 1.0 / 0.5 | | 0.7 / 0.7 | 0.3 / 0.3 |

pg_textsearch ranks "any word" (BM25 over the query's terms); "all words" is SQLite's default
`MATCH` semantics. Filtered queries return the same row counts in all three engines.

**Typos:** Valenca, empadronamento, Ptsharev, whatsap — 100% recall and precision in every engine,
both sizes (a best case: the corpus has no deliberate look-alikes).

## Cost at 1M

| | SQLite | PGlite | Postgres (Docker) |
|---|---|---|---|
| load | 193k rows/s | 139k rows/s | 463k rows/s |
| index build after load | ~24 s | ~45 s | ~23 s |
| disk | 806 MB | 1.63 GB | 1.66 GB |
| memory, query process | 154 MB | 858 MB | 328 MB |
| open | 0.6 ms | 165 ms | — |
| process start → first answer | 175 ms | 251 ms | 91 ms |

At 100k under Bun, SQLite and PGlite were in the same range as under Node.

## Where the time goes (the requirement's list, §26)

- **Index / schema** — the dominant cost in every engine: chat, sender and date filters are not
  inside the full-text index. SQLite scores every match, then filters (16–25 ms for common words,
  more for "any word"). Postgres walks its ranked list and drops rows the filter rejects — for a
  small chat thousands of rows before 20 pass; native Postgres hits 150 ms there too, so this is the
  query shape, not WASM.
- **WASM** — PGlite 2–3× slower than native Postgres on identical plans: real, secondary.
- **Query planner** — SQLite's plain `JOIN` plan above.
- **Ranking, fuzzy** — cheap everywhere.
- **I/O** — not measured: the data directory was RAM-backed.

## Defects and gaps

- **PGlite returned non-matching rows.** When a chat filter narrowed rows first, PGlite
  (pg_textsearch 1.3.1) returned messages containing neither word with score 0 — 337 of 400. Native
  Postgres with the newer extension did not. Every Postgres query keeps only `score < 0` rows.
- **Not measured:** 10M (estimated disk: SQLite ~8 GB, PGlite ~16 GB; did not fit the RAM-backed
  disk); one chat of 1M; a small chat inside a 10M corpus — estimated 150–250 ms for SQLite with
  common words, because it still scores every match in the corpus.
- **Rare-word "all words" rows are a best case**: generated words are independent, so real chats
  fall back to "any word" more often.
