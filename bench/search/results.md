# Search engine benchmark — results

Rows are appended by the scripts as each measurement finishes; a stopped run leaves its numbers.
The summary and verdict are at the bottom.

## Environment and settings

- AMD Ryzen AI 9 HX 470 (24 threads), 30 GB RAM (about 5–7 GB free during the run), Linux 7.0.
- Data and databases on **tmpfs** (`/tmp`, RAM-backed): disk I/O is **not** measured. "Cold open" is a
  new process with a warm OS cache (caches cannot be dropped without root).
- Node v24.19.0 (`node:sqlite`, SQLite 3.53.3); Bun 1.3.14 (`bun:sqlite`, SQLite 3.53.0).
- `@electric-sql/pglite` 0.5.8 (PostgreSQL 18.3 in WASM) + contrib `pg_trgm`, `unaccent` +
  `@electric-sql/pglite-pg_textsearch` 0.0.10 (pg_textsearch 1.3.1). PGlite server settings are defaults;
  `maintenance_work_mem = 256MB` set per session for index builds.
- Docker reference: `timescale/timescaledb-ha:pg18` (already local) = PostgreSQL 18.6 + pg_textsearch **1.4.0**,
  `shared_buffers=256MB maintenance_work_mem=256MB fsync=off synchronous_commit=off full_page_writes=off`,
  client `pg` 8.23.0 over TCP on localhost.
- Corpus (`gen.ts`, seed 42): ~200 chats (chat 0 holds 50%), 5,000 senders (Zipf 0.8), 3 sources, 3 years of
  dates in id order, 5–40 words per message. Words: Zipf(1.0) over 30k-word vocabularies per language
  (Russian, Spanish, English; a chat has a main language, 15% of words from another), 1.5% numbers, 1.5%
  one-off junk words (names, typos) so the vocabulary keeps growing with N. Targets planted at fixed rates;
  typo strings are guaranteed absent. Ground truth = scan of normalized tokens of every message.
- Normalization (in `gen.ts`, loaded identically by every engine): NFKD → strip `\p{M}` → NFC → lowercase
  (so ё→е, й→и, á→a, ñ→n). Queries go through the same function. The term count after indexing is identical
  in FTS5 (`fts5vocab`) and Postgres (`ts_stat` over `to_tsvector('simple')`): tokenization parity.
- SQLite: WAL, `synchronous=OFF` and `cache_size=256MB` for the build, rows in 50k-row transactions, FTS5
  external-content (`unicode61 remove_diacritics 2`) `rebuild` + `optimize` after load, btree
  `(chat_id, sent_at)`, `(sender_id)`, `(source)`; queries with `cache_size=64MB`.
  Fuzzy: `fts5vocab` → `vocab(term, doc)` → `vocab_tri(tri, len, term_id)` WITHOUT ROWID, built in JS.
- Postgres (PGlite and Docker): same table, PK + the same btree indexes, `bm25(normalized_text)
  WITH (text_config='simple')`, `vocab` from `ts_stat`, `gin_trgm_ops` on `vocab.term`, `VACUUM ANALYZE`.
- Queries: 20 timed runs after 2 warm-ups. The 2-word classes draw **20 different word pairs** per run
  from document-frequency bands: "~1% df" = each word in 0.3–3% of messages; "5–15% df" = common words.
  "3 words" = two ~1% words + one common. **Semantics differ:** FTS5 `"a" "b"` is AND; pg_textsearch
  scores any matching term (OR). SQLite OR rows are included for a like-for-like comparison.
- Fuzzy flow (both engines): term found in vocabulary → use it; otherwise candidates by trigram overlap
  (length ±2), Damerau-Levenshtein ≤ 2 in JS (≤ 1 for words of ≤ 4 letters), keep the nearest distance,
  top 5 by document frequency, OR them into the search. Latency = correction + search with LIMIT 20;
  recall = the full match set (no LIMIT) against ground truth.

Smoke-run finding: with a plain `JOIN`, SQLite's planner chose the `(chat_id, sent_at)` index for
"big chat + last 90 days" and ran the FTS5 MATCH once per row (`SCAN messages_fts VIRTUAL TABLE INDEX 0:=M1`):
76 ms p50 (1% words) and 199 ms p50 (common words) at only 100k rows. All SQLite runs below use
`FROM messages_fts CROSS JOIN messages m`, which forces the full-text side first.

## N = 100000 

#### Build — sqlite

| engine | runtime | N | variant | load | index build | disk | peak RSS |
|---|---|---|---|---|---|---|---|
| sqlite | node v24.19.0 | 100,000 | inline | 94,798 rows/s (1.05 s) | FTS rebuild 0.00 s + optimize 0.07 s; btree 0.09 s; vocab+trigram 2.07 s (143,501 terms, 1,253,614 trigram rows) | 95 MB | 492 MB |
| sqlite | node v24.19.0 | 100,000 | after | 249,608 rows/s (0.40 s) | FTS rebuild 0.58 s + optimize 0.07 s; btree 0.09 s; vocab+trigram 2.16 s (143,501 terms, 1,253,614 trigram rows) | 95 MB | 461 MB |

#### Queries — sqlite

**sqlite node v24.19.0 100,000** — open 1.00 ms; process start → first search answered 103 ms

| engine | N | query | p50 ms | p95 ms | notes |
|---|---|---|---|---|---|
| sqlite node v24.19.0 | 100,000 | BM25 AND 2 words ~1% df — all | 0.13 | 0.27 | avg rows 3.8 |
| sqlite node v24.19.0 | 100,000 | BM25 AND 2 words ~1% df — big chat (50%) | 0.08 | 0.21 | avg rows 2.7 |
| sqlite node v24.19.0 | 100,000 | BM25 AND 2 words ~1% df — small chat (202 msgs) | 0.07 | 0.16 | avg rows 0.1 |
| sqlite node v24.19.0 | 100,000 | BM25 AND 2 words ~1% df — date: last 30 days | 0.06 | 0.17 | avg rows 0.1 |
| sqlite node v24.19.0 | 100,000 | BM25 AND 2 words ~1% df — sender (372 msgs) | 0.06 | 0.09 | avg rows 0.0 |
| sqlite node v24.19.0 | 100,000 | BM25 AND 2 words ~1% df — big chat + last 90 days | 0.06 | 0.16 | avg rows 0.2 |
| sqlite node v24.19.0 | 100,000 | BM25 OR 2 words ~1% df — all | 2.22 | 4.03 | avg rows 20.0 |
| sqlite node v24.19.0 | 100,000 | BM25 AND 2 words 5–15% df — all | 0.86 | 3.23 | avg rows 20.0 |
| sqlite node v24.19.0 | 100,000 | BM25 AND 2 words 5–15% df — big chat (50%) | 0.77 | 2.02 | avg rows 19.1 |
| sqlite node v24.19.0 | 100,000 | BM25 AND 2 words 5–15% df — small chat (202 msgs) | 0.64 | 1.69 | avg rows 1.4 |
| sqlite node v24.19.0 | 100,000 | BM25 AND 2 words 5–15% df — date: last 30 days | 0.74 | 2.28 | avg rows 11.3 |
| sqlite node v24.19.0 | 100,000 | BM25 AND 2 words 5–15% df — sender (372 msgs) | 0.67 | 2.18 | avg rows 3.0 |
| sqlite node v24.19.0 | 100,000 | BM25 AND 2 words 5–15% df — big chat + last 90 days | 0.68 | 2.07 | avg rows 11.3 |
| sqlite node v24.19.0 | 100,000 | BM25 OR 2 words 5–15% df — all | 11.1 | 14.6 | avg rows 20.0 |
| sqlite node v24.19.0 | 100,000 | BM25 AND 3 words — all | 0.11 | 0.34 | avg rows 0.6 |
| sqlite node v24.19.0 | 100,000 | BM25 OR 3 words — all | 7.91 | 11.8 | avg rows 20.0 |
| sqlite node v24.19.0 | 100,000 | fuzzy "Valenca" (correction + search) | 0.87 | 1.10 | correction alone p50 0.74 / p95 0.77 ms → valencia |
| sqlite node v24.19.0 | 100,000 | fuzzy "empadronamento" (correction + search) | 2.07 | 2.24 | correction alone p50 2.04 / p95 2.25 ms → empadronamiento |
| sqlite node v24.19.0 | 100,000 | fuzzy "Ptsharev" (correction + search) | 0.94 | 1.48 | correction alone p50 0.87 / p95 0.96 ms → ptsarev |
| sqlite node v24.19.0 | 100,000 | fuzzy "whatsap" (correction + search) | 0.48 | 0.62 | correction alone p50 0.38 / p95 0.44 ms → whatsapp |
| sqlite node v24.19.0 | 100,000 | accent: València | 0.05 | 0.06 | recall 100.0% of 85 |
| sqlite node v24.19.0 | 100,000 | Cyrillic: счёт | 0.04 | 0.05 | recall 100.0% of 48 |
| sqlite node v24.19.0 | 100,000 | Cyrillic: СЧЕТ | 0.03 | 0.04 | recall 100.0% of 48 |

Fuzzy recall — sqlite node v24.19.0 100,000

| engine | N | typo | corrected to | truth msgs | returned | recall | precision |
|---|---|---|---|---|---|---|---|
| sqlite node v24.19.0 | 100,000 | "Valenca" | valencia | 85 | 85 | 100.0% | 100.0% |
| sqlite node v24.19.0 | 100,000 | "empadronamento" | empadronamiento | 19 | 19 | 100.0% | 100.0% |
| sqlite node v24.19.0 | 100,000 | "Ptsharev" | ptsarev | 9 | 9 | 100.0% | 100.0% |
| sqlite node v24.19.0 | 100,000 | "whatsap" | whatsapp | 130 | 130 | 100.0% | 100.0% |

```
-- all: SCAN messages_fts VIRTUAL TABLE INDEX 0:M1 / SEARCH m USING INTEGER PRIMARY KEY (rowid=?) / USE TEMP B-TREE FOR ORDER BY
-- big chat (50%): SCAN messages_fts VIRTUAL TABLE INDEX 0:M1 / SEARCH m USING INTEGER PRIMARY KEY (rowid=?) / USE TEMP B-TREE FOR ORDER BY
-- small chat (202 msgs): SCAN messages_fts VIRTUAL TABLE INDEX 0:M1 / SEARCH m USING INTEGER PRIMARY KEY (rowid=?) / USE TEMP B-TREE FOR ORDER BY
-- date: last 30 days: SCAN messages_fts VIRTUAL TABLE INDEX 0:M1 / SEARCH m USING INTEGER PRIMARY KEY (rowid=?) / USE TEMP B-TREE FOR ORDER BY
-- sender (372 msgs): SCAN messages_fts VIRTUAL TABLE INDEX 0:M1 / SEARCH m USING INTEGER PRIMARY KEY (rowid=?) / USE TEMP B-TREE FOR ORDER BY
-- big chat + last 90 days: SCAN messages_fts VIRTUAL TABLE INDEX 0:M1 / SEARCH m USING INTEGER PRIMARY KEY (rowid=?) / USE TEMP B-TREE FOR ORDER BY
-- trigram candidates: SEARCH t USING PRIMARY KEY (tri=? AND len>? AND len<?) / SEARCH v USING INTEGER PRIMARY KEY (rowid=?) / USE TEMP B-TREE FOR GROUP BY / USE TEMP B-TREE FOR ORDER BY
```
sqlite node v24.19.0 100000 query-process peak RSS 150 MB


#### Build — pglite

| engine | runtime | N | variant | load | index build | disk | peak RSS |
|---|---|---|---|---|---|---|---|
| pglite | node v24.19.0 | 100,000 | COPY /dev/blob, 100k-row chunks | 137,049 rows/s (0.73 s) | btree+PK 0.30 s; BM25 2.01 s; vocab via ts_stat 1.92 s (143,501 terms); pg_trgm GIN 0.45 s; VACUUM ANALYZE 0.24 s | 230 MB | 1171 MB |

#### Queries — pglite

**Correction:** the PGlite and Docker query rows in this 100k section, and the PGlite rows in the "N = 100000 bun" section, were measured before the `score < 0` fix and are superseded by the "N = 100000 rerun" section below. PGlite (pg_textsearch 1.3.1) returned **non-matching messages** when a btree pre-filtered the rows (small chat): 337 of 400 returned rows did not contain either word (checked with `to_tsvector @@ to_tsquery`). Docker's 1.4.0 did not. Every Postgres query now wraps the ranked query in `WHERE score < 0`.

**pglite node v24.19.0 100,000** — open 156 ms; process start → first search answered 231 ms

| engine | N | query | p50 ms | p95 ms | notes |
|---|---|---|---|---|---|
| pglite node v24.19.0 | 100,000 | BM25 OR 2 words ~1% df — all | 1.26 | 1.97 | avg rows 20.0 |
| pglite node v24.19.0 | 100,000 | BM25 OR 2 words ~1% df — big chat (50%) | 1.57 | 2.60 | avg rows 20.0 |
| pglite node v24.19.0 | 100,000 | BM25 OR 2 words ~1% df — small chat (202 msgs) | 5.38 | 5.87 | avg rows 20.0 |
| pglite node v24.19.0 | 100,000 | BM25 OR 2 words ~1% df — date: last 30 days | 3.58 | 4.72 | avg rows 19.9 |
| pglite node v24.19.0 | 100,000 | BM25 OR 2 words ~1% df — sender (372 msgs) | 2.73 | 4.66 | avg rows 5.3 |
| pglite node v24.19.0 | 100,000 | BM25 OR 2 words ~1% df — big chat + last 90 days | 2.06 | 4.14 | avg rows 18.4 |
| pglite node v24.19.0 | 100,000 | BM25 OR 2 words 5–15% df — all | 0.95 | 1.65 | avg rows 20.0 |
| pglite node v24.19.0 | 100,000 | BM25 OR 2 words 5–15% df — big chat (50%) | 1.43 | 9.15 | avg rows 20.0 |
| pglite node v24.19.0 | 100,000 | BM25 OR 2 words 5–15% df — small chat (202 msgs) | 4.70 | 5.01 | avg rows 20.0 |
| pglite node v24.19.0 | 100,000 | BM25 OR 2 words 5–15% df — date: last 30 days | 4.95 | 6.39 | avg rows 20.0 |
| pglite node v24.19.0 | 100,000 | BM25 OR 2 words 5–15% df — sender (372 msgs) | 22.5 | 27.7 | avg rows 20.0 |
| pglite node v24.19.0 | 100,000 | BM25 OR 2 words 5–15% df — big chat + last 90 days | 8.29 | 25.1 | avg rows 20.0 |
| pglite node v24.19.0 | 100,000 | BM25 OR 3 words — all | 0.90 | 1.01 | avg rows 20.0 |
| pglite node v24.19.0 | 100,000 | fuzzy "Valenca" (correction + search) | 1.53 | 2.30 | correction alone p50 0.79 / p95 1.21 ms → valencia |
| pglite node v24.19.0 | 100,000 | fuzzy "empadronamento" (correction + search) | 1.75 | 2.11 | correction alone p50 1.81 / p95 2.21 ms → empadronamiento |
| pglite node v24.19.0 | 100,000 | fuzzy "Ptsharev" (correction + search) | 1.15 | 1.46 | correction alone p50 0.61 / p95 0.76 ms → ptsarev |
| pglite node v24.19.0 | 100,000 | fuzzy "whatsap" (correction + search) | 1.13 | 1.35 | correction alone p50 0.52 / p95 0.61 ms → whatsapp |
| pglite node v24.19.0 | 100,000 | accent: València | 0.54 | 0.76 | recall 100.0% of 85 |
| pglite node v24.19.0 | 100,000 | Cyrillic: счёт | 0.53 | 0.63 | recall 100.0% of 48 |
| pglite node v24.19.0 | 100,000 | Cyrillic: СЧЕТ | 0.54 | 0.66 | recall 100.0% of 48 |

Fuzzy recall — pglite node v24.19.0 100,000

| engine | N | typo | corrected to | truth msgs | returned | recall | precision |
|---|---|---|---|---|---|---|---|
| pglite node v24.19.0 | 100,000 | "Valenca" | valencia | 85 | 85 | 100.0% | 100.0% |
| pglite node v24.19.0 | 100,000 | "empadronamento" | empadronamiento | 19 | 19 | 100.0% | 100.0% |
| pglite node v24.19.0 | 100,000 | "Ptsharev" | ptsarev | 9 | 9 | 100.0% | 100.0% |
| pglite node v24.19.0 | 100,000 | "whatsap" | whatsapp | 130 | 130 | 100.0% | 100.0% |

```
-- 2 words ~1% df / all: Limit (actual time=0.223..0.602 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=0.220..0.583 rows=20.00 loops=1) / Execution Time: 0.678 ms
-- 2 words ~1% df / big chat (50%): Limit (actual time=0.165..0.520 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=0.164..0.508 rows=20.00 loops=1) / Execution Time: 0.539 ms
-- 2 words ~1% df / small chat (202 msgs): Limit (actual time=4.604..4.613 rows=20.00 loops=1) / Sort (actual time=4.603..4.607 rows=20.00 loops=1) / Sort Key: ((normalized_text <@> 'messages_bm25:щюжуцецшэ school'::bm25query)) / Sort Method: top-N heapsort  Memory: 17kB / Bitmap Heap Scan on messages (actual time=0.089..4.521 rows=202.00 loops=1) / Bitmap Index Scan on messages_chat_sent (actual time=0.021..0.022 rows=202.00 loops=1) / Execution Time: 4.628 ms
-- 2 words ~1% df / date: last 30 days: Limit (actual time=0.579..2.745 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=0.578..2.734 rows=20.00 loops=1) / Execution Time: 2.761 ms
-- 2 words ~1% df / sender (372 msgs): Limit (actual time=0.336..3.761 rows=10.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=0.335..3.755 rows=10.00 loops=1) / Execution Time: 3.775 ms
-- 2 words ~1% df / big chat + last 90 days: Limit (actual time=0.132..1.559 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=0.131..1.551 rows=20.00 loops=1) / Execution Time: 1.573 ms
-- 2 words 5–15% df / all: Limit (actual time=0.338..0.876 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=0.337..0.867 rows=20.00 loops=1) / Execution Time: 0.892 ms
-- 2 words 5–15% df / big chat (50%): Limit (actual time=0.313..0.979 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=0.312..0.972 rows=20.00 loops=1) / Execution Time: 0.992 ms
-- 2 words 5–15% df / small chat (202 msgs): Limit (actual time=4.487..4.494 rows=20.00 loops=1) / Sort (actual time=4.486..4.489 rows=20.00 loops=1) / Sort Key: ((normalized_text <@> 'messages_bm25:есть good'::bm25query)) / Sort Method: top-N heapsort  Memory: 17kB / Bitmap Heap Scan on messages (actual time=0.088..4.424 rows=202.00 loops=1) / Bitmap Index Scan on messages_chat_sent (actual time=0.022..0.022 rows=202.00 loops=1) / Execution Time: 4.509 ms
-- 2 words 5–15% df / date: last 30 days: Limit (actual time=0.346..3.366 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=0.346..3.358 rows=20.00 loops=1) / Execution Time: 3.379 ms
-- 2 words 5–15% df / sender (372 msgs): Limit (actual time=3.002..17.898 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=3.001..17.888 rows=20.00 loops=1) / Execution Time: 17.916 ms
-- 2 words 5–15% df / big chat + last 90 days: Limit (actual time=0.322..3.104 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=0.321..3.096 rows=20.00 loops=1) / Execution Time: 3.123 ms
-- trigram candidates: ->  Bitmap Heap Scan on vocab  (cost=107.82..158.88 rows=1 width=20) (actual time=0.213..0.235 rows=2.00 loops=1) / Rows Removed by Index Recheck: 58 / Rows Removed by Filter: 6 / ->  Bitmap Index Scan on vocab_trgm  (cost=0.00..107.82 rows=14 width=0) (actual time=0.120..0.121 rows=66.00 loops=1) / Execution Time: 0.262 ms
```
pglite node v24.19.0 100000 query-process peak RSS 859 MB


#### Build — docker postgres

| engine | runtime | N | variant | load | index build | disk | peak RSS |
|---|---|---|---|---|---|---|---|
| postgres 18.6 docker (pg_textsearch 1.4.0) | node v24.19.0 client | 100,000 | server-side COPY | 669,739 rows/s (0.15 s) | btree+PK 0.10 s; BM25 1.01 s; vocab via ts_stat 1.29 s (143,501 terms); pg_trgm GIN 0.36 s; VACUUM ANALYZE 0.22 s | 237 MB | 437 MB (container cgroup peak, incl. page cache) |

#### Queries — docker postgres

**postgres 18.6 docker 100,000** — connect 20.5 ms, first search answered 90.2 ms after process start (server restarted just before)

| engine | N | query | p50 ms | p95 ms | notes |
|---|---|---|---|---|---|
| postgres 18.6 docker | 100,000 | BM25 OR 2 words ~1% df — all | 0.59 | 0.75 | avg rows 20.0 |
| postgres 18.6 docker | 100,000 | BM25 OR 2 words ~1% df — big chat (50%) | 0.50 | 0.82 | avg rows 20.0 |
| postgres 18.6 docker | 100,000 | BM25 OR 2 words ~1% df — small chat (202 msgs) | 1.91 | 4.78 | avg rows 3.1 |
| postgres 18.6 docker | 100,000 | BM25 OR 2 words ~1% df — date: last 30 days | 1.11 | 1.46 | avg rows 19.9 |
| postgres 18.6 docker | 100,000 | BM25 OR 2 words ~1% df — sender (372 msgs) | 1.43 | 2.85 | avg rows 5.3 |
| postgres 18.6 docker | 100,000 | BM25 OR 2 words ~1% df — big chat + last 90 days | 1.12 | 1.47 | avg rows 18.4 |
| postgres 18.6 docker | 100,000 | BM25 OR 2 words 5–15% df — all | 0.55 | 0.69 | avg rows 20.0 |
| postgres 18.6 docker | 100,000 | BM25 OR 2 words 5–15% df — big chat (50%) | 0.65 | 6.84 | avg rows 20.0 |
| postgres 18.6 docker | 100,000 | BM25 OR 2 words 5–15% df — small chat (202 msgs) | 8.02 | 11.3 | avg rows 17.2 |
| postgres 18.6 docker | 100,000 | BM25 OR 2 words 5–15% df — date: last 30 days | 2.53 | 4.16 | avg rows 20.0 |
| postgres 18.6 docker | 100,000 | BM25 OR 2 words 5–15% df — sender (372 msgs) | 6.63 | 9.23 | avg rows 20.0 |
| postgres 18.6 docker | 100,000 | BM25 OR 2 words 5–15% df — big chat + last 90 days | 1.45 | 11.4 | avg rows 20.0 |
| postgres 18.6 docker | 100,000 | BM25 OR 3 words — all | 0.39 | 0.47 | avg rows 20.0 |
| postgres 18.6 docker | 100,000 | fuzzy "Valenca" (correction + search) | 0.52 | 0.90 | correction alone p50 0.39 / p95 0.47 ms → valencia |
| postgres 18.6 docker | 100,000 | fuzzy "empadronamento" (correction + search) | 0.77 | 1.13 | correction alone p50 0.40 / p95 0.60 ms → empadronamiento |
| postgres 18.6 docker | 100,000 | fuzzy "Ptsharev" (correction + search) | 0.42 | 0.64 | correction alone p50 0.31 / p95 0.40 ms → ptsarev |
| postgres 18.6 docker | 100,000 | fuzzy "whatsap" (correction + search) | 0.39 | 0.56 | correction alone p50 0.20 / p95 0.33 ms → whatsapp |
| postgres 18.6 docker | 100,000 | accent: València | 0.27 | 0.29 | recall 100.0% of 85 |
| postgres 18.6 docker | 100,000 | Cyrillic: счёт | 0.19 | 0.38 | recall 100.0% of 48 |
| postgres 18.6 docker | 100,000 | Cyrillic: СЧЕТ | 0.18 | 0.30 | recall 100.0% of 48 |

Fuzzy recall — postgres 18.6 docker 100,000

| engine | N | typo | corrected to | truth msgs | returned | recall | precision |
|---|---|---|---|---|---|---|---|
| postgres 18.6 docker | 100,000 | "Valenca" | valencia | 85 | 85 | 100.0% | 100.0% |
| postgres 18.6 docker | 100,000 | "empadronamento" | empadronamiento | 19 | 19 | 100.0% | 100.0% |
| postgres 18.6 docker | 100,000 | "Ptsharev" | ptsarev | 9 | 9 | 100.0% | 100.0% |
| postgres 18.6 docker | 100,000 | "whatsap" | whatsapp | 130 | 130 | 100.0% | 100.0% |

```
-- 2 words ~1% df / all: Limit (actual time=0.083..0.209 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=0.083..0.208 rows=20.00 loops=1) / Execution Time: 0.213 ms
-- 2 words ~1% df / big chat (50%): Limit (actual time=0.144..0.245 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=0.143..0.244 rows=20.00 loops=1) / Execution Time: 0.249 ms
-- 2 words ~1% df / small chat (202 msgs): Limit (actual time=0.851..1.755 rows=6.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=0.851..1.754 rows=6.00 loops=1) / Execution Time: 1.759 ms
-- 2 words ~1% df / date: last 30 days: Limit (actual time=0.559..0.859 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=0.559..0.858 rows=20.00 loops=1) / Execution Time: 0.865 ms
-- 2 words ~1% df / sender (372 msgs): Limit (actual time=0.486..0.915 rows=10.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=0.486..0.914 rows=10.00 loops=1) / Execution Time: 0.918 ms
-- 2 words ~1% df / big chat + last 90 days: Limit (actual time=0.425..0.687 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=0.424..0.685 rows=20.00 loops=1) / Execution Time: 0.692 ms
-- 2 words 5–15% df / all: Limit (actual time=0.228..0.387 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=0.228..0.386 rows=20.00 loops=1) / Execution Time: 0.393 ms
-- 2 words 5–15% df / big chat (50%): Limit (actual time=0.317..0.489 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=0.317..0.488 rows=20.00 loops=1) / Execution Time: 0.494 ms
-- 2 words 5–15% df / small chat (202 msgs): Limit (actual time=3.957..10.730 rows=15.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=3.957..10.728 rows=15.00 loops=1) / Execution Time: 10.740 ms
-- 2 words 5–15% df / date: last 30 days: Limit (actual time=1.431..1.755 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=1.431..1.753 rows=20.00 loops=1) / Execution Time: 1.766 ms
-- 2 words 5–15% df / sender (372 msgs): Limit (actual time=4.115..7.155 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=4.115..7.153 rows=20.00 loops=1) / Execution Time: 7.166 ms
-- 2 words 5–15% df / big chat + last 90 days: Limit (actual time=1.064..1.340 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=1.064..1.339 rows=20.00 loops=1) / Execution Time: 1.351 ms
-- trigram candidates: ->  Bitmap Heap Scan on vocab  (cost=35.32..50.86 rows=1 width=20) (actual time=0.145..0.157 rows=2.00 loops=1) / Rows Removed by Index Recheck: 58 / Rows Removed by Filter: 6 / ->  Bitmap Index Scan on vocab_trgm  (cost=0.00..35.32 rows=14 width=0) (actual time=0.092..0.092 rows=66.00 loops=1) / Execution Time: 0.171 ms
```
postgres 18.6 docker 100000 container cgroup peak 133 MB


## N = 100000 bun

#### Build — sqlite under Bun

| engine | runtime | N | variant | load | index build | disk | peak RSS |
|---|---|---|---|---|---|---|---|
| sqlite | bun 1.3.14 | 100,000 | after | 272,842 rows/s (0.37 s) | FTS rebuild 0.65 s + optimize 0.07 s; btree 0.10 s; vocab+trigram 3.49 s (143,501 terms, 1,253,614 trigram rows) | 95 MB | 447 MB |

#### Queries — sqlite under Bun

**sqlite bun 1.3.14 100,000** — open 0.94 ms; process start → first search answered 41.4 ms

| engine | N | query | p50 ms | p95 ms | notes |
|---|---|---|---|---|---|
| sqlite bun 1.3.14 | 100,000 | BM25 AND 2 words ~1% df — all | 0.08 | 0.14 | avg rows 3.8 |
| sqlite bun 1.3.14 | 100,000 | BM25 AND 2 words ~1% df — big chat (50%) | 0.05 | 0.17 | avg rows 2.7 |
| sqlite bun 1.3.14 | 100,000 | BM25 AND 2 words ~1% df — small chat (202 msgs) | 0.03 | 0.08 | avg rows 0.1 |
| sqlite bun 1.3.14 | 100,000 | BM25 AND 2 words ~1% df — date: last 30 days | 0.03 | 0.08 | avg rows 0.1 |
| sqlite bun 1.3.14 | 100,000 | BM25 AND 2 words ~1% df — sender (372 msgs) | 0.03 | 0.04 | avg rows 0.0 |
| sqlite bun 1.3.14 | 100,000 | BM25 AND 2 words ~1% df — big chat + last 90 days | 0.04 | 0.11 | avg rows 0.2 |
| sqlite bun 1.3.14 | 100,000 | BM25 OR 2 words ~1% df — all | 1.64 | 2.73 | avg rows 20.0 |
| sqlite bun 1.3.14 | 100,000 | BM25 AND 2 words 5–15% df — all | 1.09 | 3.77 | avg rows 20.0 |
| sqlite bun 1.3.14 | 100,000 | BM25 AND 2 words 5–15% df — big chat (50%) | 1.05 | 2.45 | avg rows 19.1 |
| sqlite bun 1.3.14 | 100,000 | BM25 AND 2 words 5–15% df — small chat (202 msgs) | 0.65 | 2.00 | avg rows 1.4 |
| sqlite bun 1.3.14 | 100,000 | BM25 AND 2 words 5–15% df — date: last 30 days | 0.83 | 2.29 | avg rows 11.3 |
| sqlite bun 1.3.14 | 100,000 | BM25 AND 2 words 5–15% df — sender (372 msgs) | 0.64 | 2.18 | avg rows 3.0 |
| sqlite bun 1.3.14 | 100,000 | BM25 AND 2 words 5–15% df — big chat + last 90 days | 0.68 | 2.20 | avg rows 11.3 |
| sqlite bun 1.3.14 | 100,000 | BM25 OR 2 words 5–15% df — all | 10.9 | 14.3 | avg rows 20.0 |
| sqlite bun 1.3.14 | 100,000 | BM25 AND 3 words — all | 0.09 | 0.29 | avg rows 0.6 |
| sqlite bun 1.3.14 | 100,000 | BM25 OR 3 words — all | 7.38 | 12.6 | avg rows 20.0 |
| sqlite bun 1.3.14 | 100,000 | fuzzy "Valenca" (correction + search) | 0.84 | 0.93 | correction alone p50 0.69 / p95 0.90 ms → valencia |
| sqlite bun 1.3.14 | 100,000 | fuzzy "empadronamento" (correction + search) | 2.02 | 2.10 | correction alone p50 2.00 / p95 2.11 ms → empadronamiento |
| sqlite bun 1.3.14 | 100,000 | fuzzy "Ptsharev" (correction + search) | 0.83 | 0.91 | correction alone p50 0.80 / p95 0.84 ms → ptsarev |
| sqlite bun 1.3.14 | 100,000 | fuzzy "whatsap" (correction + search) | 0.43 | 0.48 | correction alone p50 0.33 / p95 0.35 ms → whatsapp |
| sqlite bun 1.3.14 | 100,000 | accent: València | 0.05 | 0.06 | recall 100.0% of 85 |
| sqlite bun 1.3.14 | 100,000 | Cyrillic: счёт | 0.03 | 0.04 | recall 100.0% of 48 |
| sqlite bun 1.3.14 | 100,000 | Cyrillic: СЧЕТ | 0.03 | 0.03 | recall 100.0% of 48 |

Fuzzy recall — sqlite bun 1.3.14 100,000

| engine | N | typo | corrected to | truth msgs | returned | recall | precision |
|---|---|---|---|---|---|---|---|
| sqlite bun 1.3.14 | 100,000 | "Valenca" | valencia | 85 | 85 | 100.0% | 100.0% |
| sqlite bun 1.3.14 | 100,000 | "empadronamento" | empadronamiento | 19 | 19 | 100.0% | 100.0% |
| sqlite bun 1.3.14 | 100,000 | "Ptsharev" | ptsarev | 9 | 9 | 100.0% | 100.0% |
| sqlite bun 1.3.14 | 100,000 | "whatsap" | whatsapp | 130 | 130 | 100.0% | 100.0% |

sqlite bun 1.3.14 100000 query-process peak RSS 139 MB


#### Build — pglite under Bun

| engine | runtime | N | variant | load | index build | disk | peak RSS |
|---|---|---|---|---|---|---|---|
| pglite | bun 1.3.14 | 100,000 | COPY /dev/blob, 100k-row chunks | 240,405 rows/s (0.42 s) | btree+PK 0.20 s; BM25 1.53 s; vocab via ts_stat 1.60 s (143,501 terms); pg_trgm GIN 0.54 s; VACUUM ANALYZE 0.26 s | 230 MB | 1426 MB |

#### Queries — pglite under Bun

**pglite bun 1.3.14 100,000** — open 133 ms; process start → first search answered 178 ms

| engine | N | query | p50 ms | p95 ms | notes |
|---|---|---|---|---|---|
| pglite bun 1.3.14 | 100,000 | BM25 OR 2 words ~1% df — all | 1.40 | 1.89 | avg rows 20.0 |
| pglite bun 1.3.14 | 100,000 | BM25 OR 2 words ~1% df — big chat (50%) | 1.15 | 1.73 | avg rows 20.0 |
| pglite bun 1.3.14 | 100,000 | BM25 OR 2 words ~1% df — small chat (202 msgs) | 5.64 | 8.48 | avg rows 20.0 |
| pglite bun 1.3.14 | 100,000 | BM25 OR 2 words ~1% df — date: last 30 days | 3.09 | 5.37 | avg rows 19.9 |
| pglite bun 1.3.14 | 100,000 | BM25 OR 2 words ~1% df — sender (372 msgs) | 3.00 | 8.76 | avg rows 5.3 |
| pglite bun 1.3.14 | 100,000 | BM25 OR 2 words ~1% df — big chat + last 90 days | 1.82 | 3.26 | avg rows 18.4 |
| pglite bun 1.3.14 | 100,000 | BM25 OR 2 words 5–15% df — all | 0.94 | 2.22 | avg rows 20.0 |
| pglite bun 1.3.14 | 100,000 | BM25 OR 2 words 5–15% df — big chat (50%) | 1.30 | 8.17 | avg rows 20.0 |
| pglite bun 1.3.14 | 100,000 | BM25 OR 2 words 5–15% df — small chat (202 msgs) | 4.89 | 9.55 | avg rows 20.0 |
| pglite bun 1.3.14 | 100,000 | BM25 OR 2 words 5–15% df — date: last 30 days | 4.44 | 5.52 | avg rows 20.0 |
| pglite bun 1.3.14 | 100,000 | BM25 OR 2 words 5–15% df — sender (372 msgs) | 14.9 | 17.9 | avg rows 20.0 |
| pglite bun 1.3.14 | 100,000 | BM25 OR 2 words 5–15% df — big chat + last 90 days | 3.75 | 17.2 | avg rows 20.0 |
| pglite bun 1.3.14 | 100,000 | BM25 OR 3 words — all | 0.82 | 0.90 | avg rows 20.0 |
| pglite bun 1.3.14 | 100,000 | fuzzy "Valenca" (correction + search) | 1.23 | 1.69 | correction alone p50 0.60 / p95 0.74 ms → valencia |
| pglite bun 1.3.14 | 100,000 | fuzzy "empadronamento" (correction + search) | 1.35 | 1.45 | correction alone p50 0.67 / p95 0.77 ms → empadronamiento |
| pglite bun 1.3.14 | 100,000 | fuzzy "Ptsharev" (correction + search) | 1.00 | 1.27 | correction alone p50 0.49 / p95 0.62 ms → ptsarev |
| pglite bun 1.3.14 | 100,000 | fuzzy "whatsap" (correction + search) | 0.96 | 1.38 | correction alone p50 0.41 / p95 0.67 ms → whatsapp |
| pglite bun 1.3.14 | 100,000 | accent: València | 0.53 | 0.77 | recall 100.0% of 85 |
| pglite bun 1.3.14 | 100,000 | Cyrillic: счёт | 0.51 | 0.56 | recall 100.0% of 48 |
| pglite bun 1.3.14 | 100,000 | Cyrillic: СЧЕТ | 0.63 | 0.77 | recall 100.0% of 48 |

Fuzzy recall — pglite bun 1.3.14 100,000

| engine | N | typo | corrected to | truth msgs | returned | recall | precision |
|---|---|---|---|---|---|---|---|
| pglite bun 1.3.14 | 100,000 | "Valenca" | valencia | 85 | 85 | 100.0% | 100.0% |
| pglite bun 1.3.14 | 100,000 | "empadronamento" | empadronamiento | 19 | 19 | 100.0% | 100.0% |
| pglite bun 1.3.14 | 100,000 | "Ptsharev" | ptsarev | 9 | 9 | 100.0% | 100.0% |
| pglite bun 1.3.14 | 100,000 | "whatsap" | whatsapp | 130 | 130 | 100.0% | 100.0% |

pglite bun 1.3.14 100000 query-process peak RSS 429 MB


## N = 100000 rerun (Postgres engines, with the score < 0 fix)

#### Queries — pglite

**pglite node v24.19.0 100,000** — open 158 ms; process start → first search answered 245 ms

| engine | N | query | p50 ms | p95 ms | notes |
|---|---|---|---|---|---|
| pglite node v24.19.0 | 100,000 | BM25 OR 2 words ~1% df — all | 1.12 | 1.73 | avg rows 20.0 |
| pglite node v24.19.0 | 100,000 | BM25 OR 2 words ~1% df — big chat (50%) | 1.27 | 1.98 | avg rows 20.0 |
| pglite node v24.19.0 | 100,000 | BM25 OR 2 words ~1% df — small chat (202 msgs) | 5.32 | 5.71 | avg rows 3.1 |
| pglite node v24.19.0 | 100,000 | BM25 OR 2 words ~1% df — date: last 30 days | 4.50 | 5.53 | avg rows 19.9 |
| pglite node v24.19.0 | 100,000 | BM25 OR 2 words ~1% df — sender (372 msgs) | 3.04 | 5.46 | avg rows 5.3 |
| pglite node v24.19.0 | 100,000 | BM25 OR 2 words ~1% df — big chat + last 90 days | 3.18 | 5.15 | avg rows 18.4 |
| pglite node v24.19.0 | 100,000 | BM25 OR 2 words 5–15% df — all | 0.98 | 1.05 | avg rows 20.0 |
| pglite node v24.19.0 | 100,000 | BM25 OR 2 words 5–15% df — big chat (50%) | 1.46 | 9.02 | avg rows 20.0 |
| pglite node v24.19.0 | 100,000 | BM25 OR 2 words 5–15% df — small chat (202 msgs) | 4.68 | 5.35 | avg rows 17.2 |
| pglite node v24.19.0 | 100,000 | BM25 OR 2 words 5–15% df — date: last 30 days | 4.98 | 6.27 | avg rows 20.0 |
| pglite node v24.19.0 | 100,000 | BM25 OR 2 words 5–15% df — sender (372 msgs) | 19.5 | 25.4 | avg rows 20.0 |
| pglite node v24.19.0 | 100,000 | BM25 OR 2 words 5–15% df — big chat + last 90 days | 4.94 | 22.2 | avg rows 20.0 |
| pglite node v24.19.0 | 100,000 | BM25 OR 3 words — all | 1.01 | 1.10 | avg rows 20.0 |
| pglite node v24.19.0 | 100,000 | fuzzy "Valenca" (correction + search) | 1.60 | 1.95 | correction alone p50 0.81 / p95 0.91 ms → valencia |
| pglite node v24.19.0 | 100,000 | fuzzy "empadronamento" (correction + search) | 1.96 | 2.23 | correction alone p50 0.91 / p95 0.99 ms → empadronamiento |
| pglite node v24.19.0 | 100,000 | fuzzy "Ptsharev" (correction + search) | 1.29 | 1.69 | correction alone p50 0.62 / p95 0.84 ms → ptsarev |
| pglite node v24.19.0 | 100,000 | fuzzy "whatsap" (correction + search) | 1.23 | 1.64 | correction alone p50 0.56 / p95 0.69 ms → whatsapp |
| pglite node v24.19.0 | 100,000 | accent: València | 0.52 | 0.79 | recall 100.0% of 85 |
| pglite node v24.19.0 | 100,000 | Cyrillic: счёт | 0.59 | 0.68 | recall 100.0% of 48 |
| pglite node v24.19.0 | 100,000 | Cyrillic: СЧЕТ | 0.68 | 0.89 | recall 100.0% of 48 |

Fuzzy recall — pglite node v24.19.0 100,000

| engine | N | typo | corrected to | truth msgs | returned | recall | precision |
|---|---|---|---|---|---|---|---|
| pglite node v24.19.0 | 100,000 | "Valenca" | valencia | 85 | 85 | 100.0% | 100.0% |
| pglite node v24.19.0 | 100,000 | "empadronamento" | empadronamiento | 19 | 19 | 100.0% | 100.0% |
| pglite node v24.19.0 | 100,000 | "Ptsharev" | ptsarev | 9 | 9 | 100.0% | 100.0% |
| pglite node v24.19.0 | 100,000 | "whatsap" | whatsapp | 130 | 130 | 100.0% | 100.0% |

```
-- 2 words ~1% df / all: Subquery Scan on s (actual time=0.235..0.555 rows=20.00 loops=1) / Limit (actual time=0.230..0.535 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=0.228..0.522 rows=20.00 loops=1) / Execution Time: 0.639 ms
-- 2 words ~1% df / big chat (50%): Subquery Scan on s (actual time=0.192..0.547 rows=20.00 loops=1) / Limit (actual time=0.191..0.535 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=0.189..0.524 rows=20.00 loops=1) / Execution Time: 0.569 ms
-- 2 words ~1% df / small chat (202 msgs): Subquery Scan on s (actual time=4.638..4.653 rows=6.00 loops=1) / Limit (actual time=4.636..4.645 rows=20.00 loops=1) / Sort (actual time=4.635..4.638 rows=20.00 loops=1) / Sort Key: ((messages.normalized_text <@> 'messages_bm25:щюжуцецшэ school'::bm25query)) / Sort Method: top-N heapsort  Memory: 17kB / Bitmap Heap Scan on messages (actual time=0.096..4.524 rows=202.00 loops=1) / Bitmap Index Scan on messages_chat_sent (actual time=0.022..0.022 rows=202.00 loops=1) / Execution Time: 4.677 ms
-- 2 words ~1% df / date: last 30 days: Subquery Scan on s (actual time=0.590..2.807 rows=20.00 loops=1) / Limit (actual time=0.589..2.797 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=0.588..2.787 rows=20.00 loops=1) / Execution Time: 2.828 ms
-- 2 words ~1% df / sender (372 msgs): Subquery Scan on s (actual time=0.338..4.301 rows=10.00 loops=1) / Limit (actual time=0.337..4.295 rows=10.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=0.336..4.003 rows=10.00 loops=1) / Execution Time: 4.319 ms
-- 2 words ~1% df / big chat + last 90 days: Subquery Scan on s (actual time=0.134..1.670 rows=20.00 loops=1) / Limit (actual time=0.133..1.663 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=0.132..1.657 rows=20.00 loops=1) / Execution Time: 1.688 ms
-- 2 words 5–15% df / all: Subquery Scan on s (actual time=0.334..0.692 rows=20.00 loops=1) / Limit (actual time=0.333..0.684 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=0.333..0.678 rows=20.00 loops=1) / Execution Time: 0.707 ms
-- 2 words 5–15% df / big chat (50%): Subquery Scan on s (actual time=0.329..1.052 rows=20.00 loops=1) / Limit (actual time=0.328..1.044 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=0.327..1.036 rows=20.00 loops=1) / Execution Time: 1.069 ms
-- 2 words 5–15% df / small chat (202 msgs): Subquery Scan on s (actual time=4.537..4.551 rows=15.00 loops=1) / Limit (actual time=4.536..4.544 rows=20.00 loops=1) / Sort (actual time=4.535..4.538 rows=20.00 loops=1) / Sort Key: ((messages.normalized_text <@> 'messages_bm25:есть good'::bm25query)) / Sort Method: top-N heapsort  Memory: 17kB / Bitmap Heap Scan on messages (actual time=0.116..4.475 rows=202.00 loops=1) / Bitmap Index Scan on messages_chat_sent (actual time=0.029..0.030 rows=202.00 loops=1) / Execution Time: 4.572 ms
-- 2 words 5–15% df / date: last 30 days: Subquery Scan on s (actual time=0.343..3.400 rows=20.00 loops=1) / Limit (actual time=0.342..3.391 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=0.341..3.384 rows=20.00 loops=1) / Execution Time: 3.415 ms
-- 2 words 5–15% df / sender (372 msgs): Subquery Scan on s (actual time=3.078..18.813 rows=20.00 loops=1) / Limit (actual time=3.077..18.800 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=3.075..18.787 rows=20.00 loops=1) / Execution Time: 18.841 ms
-- 2 words 5–15% df / big chat + last 90 days: Subquery Scan on s (actual time=0.391..3.650 rows=20.00 loops=1) / Limit (actual time=0.389..3.639 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=0.387..3.628 rows=20.00 loops=1) / Execution Time: 3.679 ms
-- trigram candidates: ->  Bitmap Heap Scan on vocab  (cost=107.82..158.88 rows=1 width=20) (actual time=0.244..0.267 rows=2.00 loops=1) / Rows Removed by Index Recheck: 58 / Rows Removed by Filter: 6 / ->  Bitmap Index Scan on vocab_trgm  (cost=0.00..107.82 rows=14 width=0) (actual time=0.140..0.141 rows=66.00 loops=1) / Execution Time: 0.304 ms
```
pglite node v24.19.0 100000 query-process peak RSS 860 MB


#### Build — docker postgres (rebuilt for the rerun)

| engine | runtime | N | variant | load | index build | disk | peak RSS |
|---|---|---|---|---|---|---|---|
| postgres 18.6 docker (pg_textsearch 1.4.0) | node v24.19.0 client | 100,000 | server-side COPY | 596,415 rows/s (0.17 s) | btree+PK 0.11 s; BM25 0.98 s; vocab via ts_stat 1.29 s (143,501 terms); pg_trgm GIN 0.38 s; VACUUM ANALYZE 0.18 s | 237 MB | 446 MB (container cgroup peak, incl. page cache) |

#### Queries — docker postgres

**postgres 18.6 docker 100,000** — connect 12.8 ms, first search answered 90.3 ms after process start (server restarted just before)

| engine | N | query | p50 ms | p95 ms | notes |
|---|---|---|---|---|---|
| postgres 18.6 docker | 100,000 | BM25 OR 2 words ~1% df — all | 0.47 | 0.59 | avg rows 20.0 |
| postgres 18.6 docker | 100,000 | BM25 OR 2 words ~1% df — big chat (50%) | 0.81 | 1.76 | avg rows 20.0 |
| postgres 18.6 docker | 100,000 | BM25 OR 2 words ~1% df — small chat (202 msgs) | 2.63 | 7.06 | avg rows 3.1 |
| postgres 18.6 docker | 100,000 | BM25 OR 2 words ~1% df — date: last 30 days | 1.22 | 2.42 | avg rows 19.9 |
| postgres 18.6 docker | 100,000 | BM25 OR 2 words ~1% df — sender (372 msgs) | 2.28 | 3.88 | avg rows 5.3 |
| postgres 18.6 docker | 100,000 | BM25 OR 2 words ~1% df — big chat + last 90 days | 1.01 | 1.33 | avg rows 18.4 |
| postgres 18.6 docker | 100,000 | BM25 OR 2 words 5–15% df — all | 0.54 | 0.71 | avg rows 20.0 |
| postgres 18.6 docker | 100,000 | BM25 OR 2 words 5–15% df — big chat (50%) | 0.64 | 7.55 | avg rows 20.0 |
| postgres 18.6 docker | 100,000 | BM25 OR 2 words 5–15% df — small chat (202 msgs) | 8.43 | 14.0 | avg rows 17.2 |
| postgres 18.6 docker | 100,000 | BM25 OR 2 words 5–15% df — date: last 30 days | 1.92 | 2.23 | avg rows 20.0 |
| postgres 18.6 docker | 100,000 | BM25 OR 2 words 5–15% df — sender (372 msgs) | 7.02 | 8.92 | avg rows 20.0 |
| postgres 18.6 docker | 100,000 | BM25 OR 2 words 5–15% df — big chat + last 90 days | 1.70 | 12.8 | avg rows 20.0 |
| postgres 18.6 docker | 100,000 | BM25 OR 3 words — all | 0.42 | 0.46 | avg rows 20.0 |
| postgres 18.6 docker | 100,000 | fuzzy "Valenca" (correction + search) | 0.65 | 0.86 | correction alone p50 0.36 / p95 0.44 ms → valencia |
| postgres 18.6 docker | 100,000 | fuzzy "empadronamento" (correction + search) | 0.79 | 1.09 | correction alone p50 0.87 / p95 1.44 ms → empadronamiento |
| postgres 18.6 docker | 100,000 | fuzzy "Ptsharev" (correction + search) | 0.96 | 1.32 | correction alone p50 0.51 / p95 0.60 ms → ptsarev |
| postgres 18.6 docker | 100,000 | fuzzy "whatsap" (correction + search) | 0.78 | 0.86 | correction alone p50 0.36 / p95 0.42 ms → whatsapp |
| postgres 18.6 docker | 100,000 | accent: València | 0.35 | 0.45 | recall 100.0% of 85 |
| postgres 18.6 docker | 100,000 | Cyrillic: счёт | 0.43 | 0.66 | recall 100.0% of 48 |
| postgres 18.6 docker | 100,000 | Cyrillic: СЧЕТ | 0.43 | 0.47 | recall 100.0% of 48 |

Fuzzy recall — postgres 18.6 docker 100,000

| engine | N | typo | corrected to | truth msgs | returned | recall | precision |
|---|---|---|---|---|---|---|---|
| postgres 18.6 docker | 100,000 | "Valenca" | valencia | 85 | 85 | 100.0% | 100.0% |
| postgres 18.6 docker | 100,000 | "empadronamento" | empadronamiento | 19 | 19 | 100.0% | 100.0% |
| postgres 18.6 docker | 100,000 | "Ptsharev" | ptsarev | 9 | 9 | 100.0% | 100.0% |
| postgres 18.6 docker | 100,000 | "whatsap" | whatsapp | 130 | 130 | 100.0% | 100.0% |

```
-- 2 words ~1% df / all: Subquery Scan on s (actual time=0.168..0.449 rows=20.00 loops=1) / Limit (actual time=0.167..0.446 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=0.166..0.443 rows=20.00 loops=1) / Execution Time: 0.461 ms
-- 2 words ~1% df / big chat (50%): Subquery Scan on s (actual time=0.312..0.536 rows=20.00 loops=1) / Limit (actual time=0.312..0.533 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=0.311..0.530 rows=20.00 loops=1) / Execution Time: 0.547 ms
-- 2 words ~1% df / small chat (202 msgs): Subquery Scan on s (actual time=1.477..2.832 rows=6.00 loops=1) / Limit (actual time=1.477..2.830 rows=6.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=1.476..2.829 rows=6.00 loops=1) / Execution Time: 2.844 ms
-- 2 words ~1% df / date: last 30 days: Subquery Scan on s (actual time=1.528..2.302 rows=20.00 loops=1) / Limit (actual time=1.528..2.298 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=1.527..2.295 rows=20.00 loops=1) / Execution Time: 2.316 ms
-- 2 words ~1% df / sender (372 msgs): Subquery Scan on s (actual time=1.355..2.664 rows=10.00 loops=1) / Limit (actual time=1.355..2.662 rows=10.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=1.354..2.660 rows=10.00 loops=1) / Execution Time: 2.675 ms
-- 2 words ~1% df / big chat + last 90 days: Subquery Scan on s (actual time=1.090..1.800 rows=20.00 loops=1) / Limit (actual time=1.089..1.797 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=1.089..1.794 rows=20.00 loops=1) / Execution Time: 1.811 ms
-- 2 words 5–15% df / all: Subquery Scan on s (actual time=0.475..0.813 rows=20.00 loops=1) / Limit (actual time=0.475..0.810 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=0.475..0.808 rows=20.00 loops=1) / Execution Time: 0.822 ms
-- 2 words 5–15% df / big chat (50%): Subquery Scan on s (actual time=0.691..1.058 rows=20.00 loops=1) / Limit (actual time=0.691..1.055 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=0.690..1.053 rows=20.00 loops=1) / Execution Time: 1.066 ms
-- 2 words 5–15% df / small chat (202 msgs): Subquery Scan on s (actual time=7.855..15.824 rows=15.00 loops=1) / Limit (actual time=7.853..15.819 rows=15.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=7.852..15.816 rows=15.00 loops=1) / Execution Time: 15.840 ms
-- 2 words 5–15% df / date: last 30 days: Subquery Scan on s (actual time=2.560..3.323 rows=20.00 loops=1) / Limit (actual time=2.559..3.319 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=2.558..3.316 rows=20.00 loops=1) / Execution Time: 3.347 ms
-- 2 words 5–15% df / sender (372 msgs): Subquery Scan on s (actual time=8.912..12.990 rows=20.00 loops=1) / Limit (actual time=8.910..12.985 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=8.908..12.981 rows=20.00 loops=1) / Execution Time: 13.012 ms
-- 2 words 5–15% df / big chat + last 90 days: Subquery Scan on s (actual time=2.109..2.682 rows=20.00 loops=1) / Limit (actual time=2.109..2.678 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=2.108..2.675 rows=20.00 loops=1) / Execution Time: 2.702 ms
-- trigram candidates: ->  Bitmap Heap Scan on vocab  (cost=35.32..50.86 rows=1 width=20) (actual time=0.297..0.322 rows=2.00 loops=1) / Rows Removed by Index Recheck: 58 / Rows Removed by Filter: 6 / ->  Bitmap Index Scan on vocab_trgm  (cost=0.00..35.32 rows=14 width=0) (actual time=0.188..0.188 rows=66.00 loops=1) / Execution Time: 0.352 ms
```
postgres 18.6 docker 100000 container cgroup peak 133 MB


#### Build — pglite under Bun

| engine | runtime | N | variant | load | index build | disk | peak RSS |
|---|---|---|---|---|---|---|---|
| pglite | bun 1.3.14 | 100,000 | COPY /dev/blob, 100k-row chunks | 225,453 rows/s (0.44 s) | btree+PK 0.21 s; BM25 1.61 s; vocab via ts_stat 2.52 s (143,501 terms); pg_trgm GIN 0.35 s; VACUUM ANALYZE 0.20 s | 230 MB | 1401 MB |

#### Queries — pglite under Bun

**pglite bun 1.3.14 100,000** — open 168 ms; process start → first search answered 217 ms

| engine | N | query | p50 ms | p95 ms | notes |
|---|---|---|---|---|---|
| pglite bun 1.3.14 | 100,000 | BM25 OR 2 words ~1% df — all | 1.69 | 3.41 | avg rows 20.0 |
| pglite bun 1.3.14 | 100,000 | BM25 OR 2 words ~1% df — big chat (50%) | 1.77 | 2.87 | avg rows 20.0 |
| pglite bun 1.3.14 | 100,000 | BM25 OR 2 words ~1% df — small chat (202 msgs) | 6.39 | 7.06 | avg rows 3.1 |
| pglite bun 1.3.14 | 100,000 | BM25 OR 2 words ~1% df — date: last 30 days | 3.44 | 5.18 | avg rows 19.9 |
| pglite bun 1.3.14 | 100,000 | BM25 OR 2 words ~1% df — sender (372 msgs) | 3.40 | 6.48 | avg rows 5.3 |
| pglite bun 1.3.14 | 100,000 | BM25 OR 2 words ~1% df — big chat + last 90 days | 2.08 | 3.28 | avg rows 18.4 |
| pglite bun 1.3.14 | 100,000 | BM25 OR 2 words 5–15% df — all | 0.96 | 1.06 | avg rows 20.0 |
| pglite bun 1.3.14 | 100,000 | BM25 OR 2 words 5–15% df — big chat (50%) | 1.61 | 10.2 | avg rows 20.0 |
| pglite bun 1.3.14 | 100,000 | BM25 OR 2 words 5–15% df — small chat (202 msgs) | 5.46 | 5.99 | avg rows 17.2 |
| pglite bun 1.3.14 | 100,000 | BM25 OR 2 words 5–15% df — date: last 30 days | 5.00 | 5.96 | avg rows 20.0 |
| pglite bun 1.3.14 | 100,000 | BM25 OR 2 words 5–15% df — sender (372 msgs) | 16.6 | 22.0 | avg rows 20.0 |
| pglite bun 1.3.14 | 100,000 | BM25 OR 2 words 5–15% df — big chat + last 90 days | 3.60 | 18.1 | avg rows 20.0 |
| pglite bun 1.3.14 | 100,000 | BM25 OR 3 words — all | 0.97 | 1.17 | avg rows 20.0 |
| pglite bun 1.3.14 | 100,000 | fuzzy "Valenca" (correction + search) | 1.55 | 2.29 | correction alone p50 0.67 / p95 0.91 ms → valencia |
| pglite bun 1.3.14 | 100,000 | fuzzy "empadronamento" (correction + search) | 1.55 | 2.54 | correction alone p50 0.87 / p95 1.29 ms → empadronamiento |
| pglite bun 1.3.14 | 100,000 | fuzzy "Ptsharev" (correction + search) | 1.08 | 1.18 | correction alone p50 0.55 / p95 0.68 ms → ptsarev |
| pglite bun 1.3.14 | 100,000 | fuzzy "whatsap" (correction + search) | 1.10 | 1.48 | correction alone p50 0.42 / p95 0.51 ms → whatsapp |
| pglite bun 1.3.14 | 100,000 | accent: València | 0.65 | 0.86 | recall 100.0% of 85 |
| pglite bun 1.3.14 | 100,000 | Cyrillic: счёт | 0.56 | 0.62 | recall 100.0% of 48 |
| pglite bun 1.3.14 | 100,000 | Cyrillic: СЧЕТ | 0.53 | 0.69 | recall 100.0% of 48 |

Fuzzy recall — pglite bun 1.3.14 100,000

| engine | N | typo | corrected to | truth msgs | returned | recall | precision |
|---|---|---|---|---|---|---|---|
| pglite bun 1.3.14 | 100,000 | "Valenca" | valencia | 85 | 85 | 100.0% | 100.0% |
| pglite bun 1.3.14 | 100,000 | "empadronamento" | empadronamiento | 19 | 19 | 100.0% | 100.0% |
| pglite bun 1.3.14 | 100,000 | "Ptsharev" | ptsarev | 9 | 9 | 100.0% | 100.0% |
| pglite bun 1.3.14 | 100,000 | "whatsap" | whatsapp | 130 | 130 | 100.0% | 100.0% |

pglite bun 1.3.14 100000 query-process peak RSS 421 MB


## N = 1000000 

#### Build — sqlite

| engine | runtime | N | variant | load | index build | disk | peak RSS |
|---|---|---|---|---|---|---|---|
| sqlite | node v24.19.0 | 1,000,000 | after | 192,966 rows/s (5.18 s) | FTS rebuild 7.80 s + optimize 0.69 s; btree 1.70 s; vocab+trigram 14.08 s (522,853 terms, 6,008,721 trigram rows) | 806 MB | 1436 MB |

#### Queries — sqlite

**sqlite node v24.19.0 1,000,000** — open 0.56 ms; process start → first search answered 175 ms

| engine | N | query | p50 ms | p95 ms | notes |
|---|---|---|---|---|---|
| sqlite node v24.19.0 | 1,000,000 | BM25 AND 2 words ~1% df — all | 0.51 | 1.58 | avg rows 15.4 |
| sqlite node v24.19.0 | 1,000,000 | BM25 AND 2 words ~1% df — big chat (50%) | 0.54 | 1.32 | avg rows 11.8 |
| sqlite node v24.19.0 | 1,000,000 | BM25 AND 2 words ~1% df — small chat (1996 msgs) | 0.19 | 0.67 | avg rows 0.1 |
| sqlite node v24.19.0 | 1,000,000 | BM25 AND 2 words ~1% df — date: last 30 days | 0.34 | 1.07 | avg rows 1.3 |
| sqlite node v24.19.0 | 1,000,000 | BM25 AND 2 words ~1% df — sender (3808 msgs) | 0.24 | 1.00 | avg rows 0.3 |
| sqlite node v24.19.0 | 1,000,000 | BM25 AND 2 words ~1% df — big chat + last 90 days | 0.31 | 0.68 | avg rows 2.3 |
| sqlite node v24.19.0 | 1,000,000 | BM25 OR 2 words ~1% df — all | 27.9 | 50.1 | avg rows 20.0 |
| sqlite node v24.19.0 | 1,000,000 | BM25 AND 2 words 5–15% df — all | 11.0 | 24.5 | avg rows 20.0 |
| sqlite node v24.19.0 | 1,000,000 | BM25 AND 2 words 5–15% df — big chat (50%) | 9.92 | 22.3 | avg rows 20.0 |
| sqlite node v24.19.0 | 1,000,000 | BM25 AND 2 words 5–15% df — small chat (1996 msgs) | 7.77 | 16.2 | avg rows 7.4 |
| sqlite node v24.19.0 | 1,000,000 | BM25 AND 2 words 5–15% df — date: last 30 days | 7.99 | 16.7 | avg rows 20.0 |
| sqlite node v24.19.0 | 1,000,000 | BM25 AND 2 words 5–15% df — sender (3808 msgs) | 8.32 | 15.9 | avg rows 13.1 |
| sqlite node v24.19.0 | 1,000,000 | BM25 AND 2 words 5–15% df — big chat + last 90 days | 8.12 | 17.9 | avg rows 18.9 |
| sqlite node v24.19.0 | 1,000,000 | BM25 OR 2 words 5–15% df — all | 159 | 201 | avg rows 20.0 |
| sqlite node v24.19.0 | 1,000,000 | BM25 AND 3 words — all | 1.58 | 4.44 | avg rows 3.5 |
| sqlite node v24.19.0 | 1,000,000 | BM25 OR 3 words — all | 95.4 | 128 | avg rows 20.0 |
| sqlite node v24.19.0 | 1,000,000 | fuzzy "Valenca" (correction + search) | 2.25 | 3.58 | correction alone p50 1.52 / p95 1.59 ms → valencia |
| sqlite node v24.19.0 | 1,000,000 | fuzzy "empadronamento" (correction + search) | 11.7 | 15.0 | correction alone p50 11.6 / p95 14.1 ms → empadronamiento |
| sqlite node v24.19.0 | 1,000,000 | fuzzy "Ptsharev" (correction + search) | 1.76 | 1.88 | correction alone p50 1.71 / p95 1.76 ms → ptsarev |
| sqlite node v24.19.0 | 1,000,000 | fuzzy "whatsap" (correction + search) | 1.57 | 2.45 | correction alone p50 0.62 / p95 0.67 ms → whatsapp |
| sqlite node v24.19.0 | 1,000,000 | accent: València | 0.64 | 0.96 | recall 100.0% of 954 |
| sqlite node v24.19.0 | 1,000,000 | Cyrillic: счёт | 0.34 | 0.49 | recall 100.0% of 504 |
| sqlite node v24.19.0 | 1,000,000 | Cyrillic: СЧЕТ | 0.30 | 0.33 | recall 100.0% of 504 |

Fuzzy recall — sqlite node v24.19.0 1,000,000

| engine | N | typo | corrected to | truth msgs | returned | recall | precision |
|---|---|---|---|---|---|---|---|
| sqlite node v24.19.0 | 1,000,000 | "Valenca" | valencia | 954 | 954 | 100.0% | 100.0% |
| sqlite node v24.19.0 | 1,000,000 | "empadronamento" | empadronamiento | 113 | 113 | 100.0% | 100.0% |
| sqlite node v24.19.0 | 1,000,000 | "Ptsharev" | ptsarev | 53 | 53 | 100.0% | 100.0% |
| sqlite node v24.19.0 | 1,000,000 | "whatsap" | whatsapp | 1344 | 1344 | 100.0% | 100.0% |

```
-- all: SCAN messages_fts VIRTUAL TABLE INDEX 0:M1 / SEARCH m USING INTEGER PRIMARY KEY (rowid=?) / USE TEMP B-TREE FOR ORDER BY
-- big chat (50%): SCAN messages_fts VIRTUAL TABLE INDEX 0:M1 / SEARCH m USING INTEGER PRIMARY KEY (rowid=?) / USE TEMP B-TREE FOR ORDER BY
-- small chat (1996 msgs): SCAN messages_fts VIRTUAL TABLE INDEX 0:M1 / SEARCH m USING INTEGER PRIMARY KEY (rowid=?) / USE TEMP B-TREE FOR ORDER BY
-- date: last 30 days: SCAN messages_fts VIRTUAL TABLE INDEX 0:M1 / SEARCH m USING INTEGER PRIMARY KEY (rowid=?) / USE TEMP B-TREE FOR ORDER BY
-- sender (3808 msgs): SCAN messages_fts VIRTUAL TABLE INDEX 0:M1 / SEARCH m USING INTEGER PRIMARY KEY (rowid=?) / USE TEMP B-TREE FOR ORDER BY
-- big chat + last 90 days: SCAN messages_fts VIRTUAL TABLE INDEX 0:M1 / SEARCH m USING INTEGER PRIMARY KEY (rowid=?) / USE TEMP B-TREE FOR ORDER BY
-- trigram candidates: SEARCH t USING PRIMARY KEY (tri=? AND len>? AND len<?) / SEARCH v USING INTEGER PRIMARY KEY (rowid=?) / USE TEMP B-TREE FOR GROUP BY / USE TEMP B-TREE FOR ORDER BY
```
sqlite node v24.19.0 1000000 query-process peak RSS 154 MB


#### Build — pglite

| engine | runtime | N | variant | load | index build | disk | peak RSS |
|---|---|---|---|---|---|---|---|
| pglite | node v24.19.0 | 1,000,000 | COPY /dev/blob, 100k-row chunks | 138,786 rows/s (7.21 s) | btree+PK 2.74 s; BM25 18.92 s; vocab via ts_stat 19.75 s (522,853 terms); pg_trgm GIN 2.46 s; VACUUM ANALYZE 0.74 s | 1634 MB | 1351 MB |

#### Queries — pglite

**pglite node v24.19.0 1,000,000** — open 165 ms; process start → first search answered 251 ms

| engine | N | query | p50 ms | p95 ms | notes |
|---|---|---|---|---|---|
| pglite node v24.19.0 | 1,000,000 | BM25 OR 2 words ~1% df — all | 1.85 | 2.47 | avg rows 20.0 |
| pglite node v24.19.0 | 1,000,000 | BM25 OR 2 words ~1% df — big chat (50%) | 2.25 | 10.5 | avg rows 20.0 |
| pglite node v24.19.0 | 1,000,000 | BM25 OR 2 words ~1% df — small chat (1996 msgs) | 40.0 | 79.5 | avg rows 17.1 |
| pglite node v24.19.0 | 1,000,000 | BM25 OR 2 words ~1% df — date: last 30 days | 6.96 | 8.95 | avg rows 20.0 |
| pglite node v24.19.0 | 1,000,000 | BM25 OR 2 words ~1% df — sender (3808 msgs) | 27.9 | 39.0 | avg rows 19.6 |
| pglite node v24.19.0 | 1,000,000 | BM25 OR 2 words ~1% df — big chat + last 90 days | 5.26 | 10.7 | avg rows 20.0 |
| pglite node v24.19.0 | 1,000,000 | BM25 OR 2 words 5–15% df — all | 3.36 | 4.16 | avg rows 20.0 |
| pglite node v24.19.0 | 1,000,000 | BM25 OR 2 words 5–15% df — big chat (50%) | 7.83 | 42.3 | avg rows 20.0 |
| pglite node v24.19.0 | 1,000,000 | BM25 OR 2 words 5–15% df — small chat (1996 msgs) | 112 | 298 | avg rows 20.0 |
| pglite node v24.19.0 | 1,000,000 | BM25 OR 2 words 5–15% df — date: last 30 days | 30.7 | 45.5 | avg rows 20.0 |
| pglite node v24.19.0 | 1,000,000 | BM25 OR 2 words 5–15% df — sender (3808 msgs) | 65.3 | 85.6 | avg rows 20.0 |
| pglite node v24.19.0 | 1,000,000 | BM25 OR 2 words 5–15% df — big chat + last 90 days | 23.3 | 107 | avg rows 20.0 |
| pglite node v24.19.0 | 1,000,000 | BM25 OR 3 words — all | 2.13 | 3.58 | avg rows 20.0 |
| pglite node v24.19.0 | 1,000,000 | fuzzy "Valenca" (correction + search) | 2.33 | 2.68 | correction alone p50 1.61 / p95 1.95 ms → valencia |
| pglite node v24.19.0 | 1,000,000 | fuzzy "empadronamento" (correction + search) | 3.19 | 3.66 | correction alone p50 2.33 / p95 2.50 ms → empadronamiento |
| pglite node v24.19.0 | 1,000,000 | fuzzy "Ptsharev" (correction + search) | 2.10 | 2.79 | correction alone p50 1.19 / p95 1.39 ms → ptsarev |
| pglite node v24.19.0 | 1,000,000 | fuzzy "whatsap" (correction + search) | 1.36 | 1.56 | correction alone p50 0.66 / p95 1.00 ms → whatsapp |
| pglite node v24.19.0 | 1,000,000 | accent: València | 0.59 | 0.67 | recall 100.0% of 954 |
| pglite node v24.19.0 | 1,000,000 | Cyrillic: счёт | 0.54 | 0.65 | recall 100.0% of 504 |
| pglite node v24.19.0 | 1,000,000 | Cyrillic: СЧЕТ | 0.53 | 0.64 | recall 100.0% of 504 |

Fuzzy recall — pglite node v24.19.0 1,000,000

| engine | N | typo | corrected to | truth msgs | returned | recall | precision |
|---|---|---|---|---|---|---|---|
| pglite node v24.19.0 | 1,000,000 | "Valenca" | valencia | 954 | 954 | 100.0% | 100.0% |
| pglite node v24.19.0 | 1,000,000 | "empadronamento" | empadronamiento | 113 | 113 | 100.0% | 100.0% |
| pglite node v24.19.0 | 1,000,000 | "Ptsharev" | ptsarev | 53 | 53 | 100.0% | 100.0% |
| pglite node v24.19.0 | 1,000,000 | "whatsap" | whatsapp | 1344 | 1344 | 100.0% | 100.0% |

```
-- 2 words ~1% df / all: Subquery Scan on s (actual time=0.770..1.317 rows=20.00 loops=1) / Limit (actual time=0.752..1.279 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=0.748..1.262 rows=20.00 loops=1) / Execution Time: 1.411 ms
-- 2 words ~1% df / big chat (50%): Subquery Scan on s (actual time=0.616..1.665 rows=20.00 loops=1) / Limit (actual time=0.614..1.651 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=0.613..1.638 rows=20.00 loops=1) / Execution Time: 1.692 ms
-- 2 words ~1% df / small chat (1996 msgs): Subquery Scan on s (actual time=3.777..45.181 rows=20.00 loops=1) / Limit (actual time=3.776..45.159 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=3.774..45.132 rows=20.00 loops=1) / Execution Time: 45.215 ms
-- 2 words ~1% df / date: last 30 days: Subquery Scan on s (actual time=2.330..6.959 rows=20.00 loops=1) / Limit (actual time=2.327..6.942 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=2.325..6.909 rows=20.00 loops=1) / Execution Time: 6.993 ms
-- 2 words ~1% df / sender (3808 msgs): Subquery Scan on s (actual time=0.593..15.104 rows=20.00 loops=1) / Limit (actual time=0.592..15.092 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=0.590..15.080 rows=20.00 loops=1) / Execution Time: 15.135 ms
-- 2 words ~1% df / big chat + last 90 days: Subquery Scan on s (actual time=0.580..3.310 rows=20.00 loops=1) / Limit (actual time=0.579..3.300 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=0.578..3.290 rows=20.00 loops=1) / Execution Time: 3.334 ms
-- 2 words 5–15% df / all: Subquery Scan on s (actual time=2.592..2.908 rows=20.00 loops=1) / Limit (actual time=2.590..2.898 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=2.589..2.889 rows=20.00 loops=1) / Execution Time: 2.927 ms
-- 2 words 5–15% df / big chat (50%): Subquery Scan on s (actual time=2.557..9.602 rows=20.00 loops=1) / Limit (actual time=2.556..9.592 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=2.555..9.280 rows=20.00 loops=1) / Execution Time: 9.623 ms
-- 2 words 5–15% df / small chat (1996 msgs): Subquery Scan on s (actual time=20.462..85.805 rows=20.00 loops=1) / Limit (actual time=20.461..85.782 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=20.458..85.760 rows=20.00 loops=1) / Execution Time: 85.843 ms
-- 2 words 5–15% df / date: last 30 days: Subquery Scan on s (actual time=2.653..20.359 rows=20.00 loops=1) / Limit (actual time=2.651..20.347 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=2.649..20.337 rows=20.00 loops=1) / Execution Time: 20.390 ms
-- 2 words 5–15% df / sender (3808 msgs): Subquery Scan on s (actual time=19.470..43.637 rows=20.00 loops=1) / Limit (actual time=19.467..43.623 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=19.464..43.609 rows=20.00 loops=1) / Execution Time: 43.670 ms
-- 2 words 5–15% df / big chat + last 90 days: Subquery Scan on s (actual time=2.605..20.099 rows=20.00 loops=1) / Limit (actual time=2.604..20.088 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=2.601..20.078 rows=20.00 loops=1) / Execution Time: 20.131 ms
-- trigram candidates: ->  Bitmap Heap Scan on vocab  (cost=108.05..297.90 rows=1 width=23) (actual time=0.915..1.011 rows=2.00 loops=1) / Rows Removed by Index Recheck: 268 / Rows Removed by Filter: 6 / ->  Bitmap Index Scan on vocab_trgm  (cost=0.00..108.05 rows=52 width=0) (actual time=0.452..0.453 rows=276.00 loops=1) / Execution Time: 1.051 ms
```
pglite node v24.19.0 1000000 query-process peak RSS 858 MB


#### Build — docker postgres

| engine | runtime | N | variant | load | index build | disk | peak RSS |
|---|---|---|---|---|---|---|---|
| postgres 18.6 docker (pg_textsearch 1.4.0) | node v24.19.0 client | 1,000,000 | server-side COPY | 463,145 rows/s (2.16 s) | btree+PK 1.50 s; BM25 7.96 s; vocab via ts_stat 11.72 s (522,853 terms); pg_trgm GIN 0.76 s; VACUUM ANALYZE 1.43 s | 1657 MB | 2222 MB (container cgroup peak, incl. page cache) |

#### Queries — docker postgres

**postgres 18.6 docker 1,000,000** — connect 10.5 ms, first search answered 91.3 ms after process start (server restarted just before)

| engine | N | query | p50 ms | p95 ms | notes |
|---|---|---|---|---|---|
| postgres 18.6 docker | 1,000,000 | BM25 OR 2 words ~1% df — all | 0.90 | 1.14 | avg rows 20.0 |
| postgres 18.6 docker | 1,000,000 | BM25 OR 2 words ~1% df — big chat (50%) | 0.90 | 1.89 | avg rows 20.0 |
| postgres 18.6 docker | 1,000,000 | BM25 OR 2 words ~1% df — small chat (1996 msgs) | 21.5 | 46.2 | avg rows 17.1 |
| postgres 18.6 docker | 1,000,000 | BM25 OR 2 words ~1% df — date: last 30 days | 3.13 | 3.87 | avg rows 20.0 |
| postgres 18.6 docker | 1,000,000 | BM25 OR 2 words ~1% df — sender (3808 msgs) | 15.7 | 20.1 | avg rows 19.6 |
| postgres 18.6 docker | 1,000,000 | BM25 OR 2 words ~1% df — big chat + last 90 days | 2.50 | 6.19 | avg rows 20.0 |
| postgres 18.6 docker | 1,000,000 | BM25 OR 2 words 5–15% df — all | 2.29 | 3.34 | avg rows 20.0 |
| postgres 18.6 docker | 1,000,000 | BM25 OR 2 words 5–15% df — big chat (50%) | 3.20 | 38.4 | avg rows 20.0 |
| postgres 18.6 docker | 1,000,000 | BM25 OR 2 words 5–15% df — small chat (1996 msgs) | 40.9 | 150 | avg rows 20.0 |
| postgres 18.6 docker | 1,000,000 | BM25 OR 2 words 5–15% df — date: last 30 days | 6.22 | 9.39 | avg rows 20.0 |
| postgres 18.6 docker | 1,000,000 | BM25 OR 2 words 5–15% df — sender (3808 msgs) | 21.7 | 26.6 | avg rows 20.0 |
| postgres 18.6 docker | 1,000,000 | BM25 OR 2 words 5–15% df — big chat + last 90 days | 5.15 | 64.9 | avg rows 20.0 |
| postgres 18.6 docker | 1,000,000 | BM25 OR 3 words — all | 1.17 | 1.90 | avg rows 20.0 |
| postgres 18.6 docker | 1,000,000 | fuzzy "Valenca" (correction + search) | 2.75 | 3.45 | correction alone p50 0.85 / p95 2.12 ms → valencia |
| postgres 18.6 docker | 1,000,000 | fuzzy "empadronamento" (correction + search) | 1.63 | 1.69 | correction alone p50 1.47 / p95 1.54 ms → empadronamiento |
| postgres 18.6 docker | 1,000,000 | fuzzy "Ptsharev" (correction + search) | 1.05 | 1.09 | correction alone p50 0.59 / p95 0.64 ms → ptsarev |
| postgres 18.6 docker | 1,000,000 | fuzzy "whatsap" (correction + search) | 0.69 | 0.74 | correction alone p50 0.26 / p95 0.42 ms → whatsapp |
| postgres 18.6 docker | 1,000,000 | accent: València | 0.21 | 0.30 | recall 100.0% of 954 |
| postgres 18.6 docker | 1,000,000 | Cyrillic: счёт | 0.19 | 0.29 | recall 100.0% of 504 |
| postgres 18.6 docker | 1,000,000 | Cyrillic: СЧЕТ | 0.19 | 0.26 | recall 100.0% of 504 |

Fuzzy recall — postgres 18.6 docker 1,000,000

| engine | N | typo | corrected to | truth msgs | returned | recall | precision |
|---|---|---|---|---|---|---|---|
| postgres 18.6 docker | 1,000,000 | "Valenca" | valencia | 954 | 954 | 100.0% | 100.0% |
| postgres 18.6 docker | 1,000,000 | "empadronamento" | empadronamiento | 113 | 113 | 100.0% | 100.0% |
| postgres 18.6 docker | 1,000,000 | "Ptsharev" | ptsarev | 53 | 53 | 100.0% | 100.0% |
| postgres 18.6 docker | 1,000,000 | "whatsap" | whatsapp | 1344 | 1344 | 100.0% | 100.0% |

```
-- 2 words ~1% df / all: Subquery Scan on s (actual time=0.829..1.291 rows=20.00 loops=1) / Limit (actual time=0.828..1.287 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=0.827..1.283 rows=20.00 loops=1) / Execution Time: 1.310 ms
-- 2 words ~1% df / big chat (50%): Subquery Scan on s (actual time=0.939..1.382 rows=20.00 loops=1) / Limit (actual time=0.939..1.378 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=0.938..1.376 rows=20.00 loops=1) / Execution Time: 1.394 ms
-- 2 words ~1% df / small chat (1996 msgs): Subquery Scan on s (actual time=13.830..34.242 rows=20.00 loops=1) / Limit (actual time=13.829..34.234 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=13.828..34.228 rows=20.00 loops=1) / Execution Time: 34.261 ms
-- 2 words ~1% df / date: last 30 days: Subquery Scan on s (actual time=3.515..4.456 rows=20.00 loops=1) / Limit (actual time=3.514..4.452 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=3.513..4.449 rows=20.00 loops=1) / Execution Time: 4.475 ms
-- 2 words ~1% df / sender (3808 msgs): Subquery Scan on s (actual time=7.184..10.164 rows=20.00 loops=1) / Limit (actual time=7.183..10.160 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=7.181..10.156 rows=20.00 loops=1) / Execution Time: 10.190 ms
-- 2 words ~1% df / big chat + last 90 days: Subquery Scan on s (actual time=2.761..3.240 rows=20.00 loops=1) / Limit (actual time=2.760..3.235 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=2.758..3.231 rows=20.00 loops=1) / Execution Time: 3.279 ms
-- 2 words 5–15% df / all: Subquery Scan on s (actual time=3.671..3.939 rows=20.00 loops=1) / Limit (actual time=3.670..3.935 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=3.669..3.932 rows=20.00 loops=1) / Execution Time: 3.952 ms
-- 2 words 5–15% df / big chat (50%): Subquery Scan on s (actual time=4.125..4.466 rows=20.00 loops=1) / Limit (actual time=4.124..4.462 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=4.123..4.459 rows=20.00 loops=1) / Execution Time: 4.482 ms
-- 2 words 5–15% df / small chat (1996 msgs): Subquery Scan on s (actual time=34.699..51.661 rows=20.00 loops=1) / Limit (actual time=34.698..51.656 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=34.696..51.652 rows=20.00 loops=1) / Execution Time: 51.683 ms
-- 2 words 5–15% df / date: last 30 days: Subquery Scan on s (actual time=8.724..9.676 rows=20.00 loops=1) / Limit (actual time=8.722..9.670 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=8.721..9.666 rows=20.00 loops=1) / Execution Time: 9.701 ms
-- 2 words 5–15% df / sender (3808 msgs): Subquery Scan on s (actual time=23.637..26.678 rows=20.00 loops=1) / Limit (actual time=23.635..26.673 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=23.634..26.669 rows=20.00 loops=1) / Execution Time: 26.698 ms
-- 2 words 5–15% df / big chat + last 90 days: Subquery Scan on s (actual time=7.556..8.549 rows=20.00 loops=1) / Limit (actual time=7.555..8.544 rows=20.00 loops=1) / Index Scan using messages_bm25 on messages (actual time=7.554..8.541 rows=20.00 loops=1) / Execution Time: 8.570 ms
-- trigram candidates: ->  Bitmap Heap Scan on vocab  (cost=35.55..93.28 rows=1 width=23) (actual time=1.334..1.438 rows=2.00 loops=1) / Rows Removed by Index Recheck: 268 / Rows Removed by Filter: 6 / ->  Bitmap Index Scan on vocab_trgm  (cost=0.00..35.55 rows=52 width=0) (actual time=0.803..0.803 rows=276.00 loops=1) / Execution Time: 1.468 ms
```
postgres 18.6 docker 1000000 container cgroup peak 328 MB


## N = 1000000 sqlite rerun (OR with every filter)

| engine | runtime | N | variant | load | index build | disk | peak RSS |
|---|---|---|---|---|---|---|---|
| sqlite | node v24.19.0 | 1,000,000 | after | 250,503 rows/s (3.99 s) | FTS rebuild 7.54 s + optimize 0.65 s; btree 1.74 s; vocab+trigram 13.38 s (522,853 terms, 6,008,721 trigram rows) | 806 MB | 1428 MB |

#### Queries — sqlite

**sqlite node v24.19.0 1,000,000** — open 0.58 ms; process start → first search answered 183 ms

| engine | N | query | p50 ms | p95 ms | notes |
|---|---|---|---|---|---|
| sqlite node v24.19.0 | 1,000,000 | BM25 AND 2 words ~1% df — all | 0.50 | 1.59 | avg rows 15.4 |
| sqlite node v24.19.0 | 1,000,000 | BM25 OR 2 words ~1% df — all | 19.8 | 41.8 | avg rows 20.0 |
| sqlite node v24.19.0 | 1,000,000 | BM25 AND 2 words ~1% df — big chat (50%) | 0.50 | 1.71 | avg rows 11.8 |
| sqlite node v24.19.0 | 1,000,000 | BM25 OR 2 words ~1% df — big chat (50%) | 17.7 | 39.3 | avg rows 20.0 |
| sqlite node v24.19.0 | 1,000,000 | BM25 AND 2 words ~1% df — small chat (1996 msgs) | 0.21 | 0.77 | avg rows 0.1 |
| sqlite node v24.19.0 | 1,000,000 | BM25 OR 2 words ~1% df — small chat (1996 msgs) | 11.2 | 25.7 | avg rows 17.1 |
| sqlite node v24.19.0 | 1,000,000 | BM25 AND 2 words ~1% df — date: last 30 days | 0.34 | 1.29 | avg rows 1.3 |
| sqlite node v24.19.0 | 1,000,000 | BM25 OR 2 words ~1% df — date: last 30 days | 11.7 | 25.4 | avg rows 20.0 |
| sqlite node v24.19.0 | 1,000,000 | BM25 AND 2 words ~1% df — sender (3808 msgs) | 0.22 | 1.16 | avg rows 0.3 |
| sqlite node v24.19.0 | 1,000,000 | BM25 OR 2 words ~1% df — sender (3808 msgs) | 15.8 | 30.8 | avg rows 19.6 |
| sqlite node v24.19.0 | 1,000,000 | BM25 AND 2 words ~1% df — big chat + last 90 days | 0.33 | 0.84 | avg rows 2.3 |
| sqlite node v24.19.0 | 1,000,000 | BM25 OR 2 words ~1% df — big chat + last 90 days | 12.9 | 26.4 | avg rows 20.0 |
| sqlite node v24.19.0 | 1,000,000 | BM25 AND 2 words 5–15% df — all | 13.8 | 27.7 | avg rows 20.0 |
| sqlite node v24.19.0 | 1,000,000 | BM25 OR 2 words 5–15% df — all | 151 | 187 | avg rows 20.0 |
| sqlite node v24.19.0 | 1,000,000 | BM25 AND 2 words 5–15% df — big chat (50%) | 11.0 | 23.5 | avg rows 20.0 |
| sqlite node v24.19.0 | 1,000,000 | BM25 OR 2 words 5–15% df — big chat (50%) | 128 | 157 | avg rows 20.0 |
| sqlite node v24.19.0 | 1,000,000 | BM25 AND 2 words 5–15% df — small chat (1996 msgs) | 8.19 | 17.0 | avg rows 7.4 |
| sqlite node v24.19.0 | 1,000,000 | BM25 OR 2 words 5–15% df — small chat (1996 msgs) | 91.4 | 109 | avg rows 20.0 |
| sqlite node v24.19.0 | 1,000,000 | BM25 AND 2 words 5–15% df — date: last 30 days | 8.13 | 16.4 | avg rows 20.0 |
| sqlite node v24.19.0 | 1,000,000 | BM25 OR 2 words 5–15% df — date: last 30 days | 96.3 | 104 | avg rows 20.0 |
| sqlite node v24.19.0 | 1,000,000 | BM25 AND 2 words 5–15% df — sender (3808 msgs) | 8.03 | 15.8 | avg rows 13.1 |
| sqlite node v24.19.0 | 1,000,000 | BM25 OR 2 words 5–15% df — sender (3808 msgs) | 90.4 | 102 | avg rows 20.0 |
| sqlite node v24.19.0 | 1,000,000 | BM25 AND 2 words 5–15% df — big chat + last 90 days | 8.47 | 22.4 | avg rows 18.9 |
| sqlite node v24.19.0 | 1,000,000 | BM25 OR 2 words 5–15% df — big chat + last 90 days | 97.6 | 115 | avg rows 20.0 |
| sqlite node v24.19.0 | 1,000,000 | BM25 AND 3 words — all | 1.67 | 3.01 | avg rows 3.5 |
| sqlite node v24.19.0 | 1,000,000 | BM25 OR 3 words — all | 102 | 151 | avg rows 20.0 |
| sqlite node v24.19.0 | 1,000,000 | fuzzy "Valenca" (correction + search) | 2.86 | 3.46 | correction alone p50 1.46 / p95 1.83 ms → valencia |
| sqlite node v24.19.0 | 1,000,000 | fuzzy "empadronamento" (correction + search) | 15.0 | 16.8 | correction alone p50 11.6 / p95 13.8 ms → empadronamiento |
| sqlite node v24.19.0 | 1,000,000 | fuzzy "Ptsharev" (correction + search) | 1.75 | 4.03 | correction alone p50 1.70 / p95 1.76 ms → ptsarev |
| sqlite node v24.19.0 | 1,000,000 | fuzzy "whatsap" (correction + search) | 1.53 | 2.02 | correction alone p50 0.59 / p95 0.62 ms → whatsapp |
| sqlite node v24.19.0 | 1,000,000 | accent: València | 0.63 | 0.70 | recall 100.0% of 954 |
| sqlite node v24.19.0 | 1,000,000 | Cyrillic: счёт | 0.31 | 0.35 | recall 100.0% of 504 |
| sqlite node v24.19.0 | 1,000,000 | Cyrillic: СЧЕТ | 0.30 | 0.35 | recall 100.0% of 504 |

Fuzzy recall — sqlite node v24.19.0 1,000,000

| engine | N | typo | corrected to | truth msgs | returned | recall | precision |
|---|---|---|---|---|---|---|---|
| sqlite node v24.19.0 | 1,000,000 | "Valenca" | valencia | 954 | 954 | 100.0% | 100.0% |
| sqlite node v24.19.0 | 1,000,000 | "empadronamento" | empadronamiento | 113 | 113 | 100.0% | 100.0% |
| sqlite node v24.19.0 | 1,000,000 | "Ptsharev" | ptsarev | 53 | 53 | 100.0% | 100.0% |
| sqlite node v24.19.0 | 1,000,000 | "whatsap" | whatsapp | 1344 | 1344 | 100.0% | 100.0% |

sqlite node v24.19.0 1000000 query-process peak RSS 155 MB

## Summary

### Build and footprint (Node 24)

| | SQLite 100k | SQLite 1M | PGlite 100k | PGlite 1M | Docker PG 100k | Docker PG 1M |
|---|---|---|---|---|---|---|
| load | 250k rows/s | 193k rows/s (5.2 s) | 137k rows/s | 139k rows/s (7.2 s) | 670k rows/s | 463k rows/s (2.2 s) |
| full-text index | 0.65 s | 8.5 s (rebuild + optimize) | 2.0 s | 18.9 s (BM25) | 1.0 s | 8.0 s |
| fuzzy vocabulary + trigrams | 2.2 s | 14.1 s (JS-built table) | 2.4 s | 22.2 s (`ts_stat` 19.8 + GIN 2.5) | 1.7 s | 12.5 s |
| btree filters | 0.09 s | 1.7 s | 0.3 s | 2.7 s | 0.1 s | 1.5 s |
| total build after load | ~3 s | ~24 s | ~5 s | ~45 s | ~3 s | ~23 s |
| disk | 95 MB | 806 MB | 230 MB | 1,634 MB | 237 MB | 1,657 MB |
| peak RSS, build | 461 MB | 1,436 MB | 1,171 MB | 1,351 MB | 437 MB cgroup incl. cache | 2,222 MB cgroup incl. cache |
| peak RSS, query process | 150 MB | 154 MB | 859 MB | 858 MB | 109 MB cgroup | 328 MB cgroup |
| open → first answer | 1 ms / 103 ms | 0.6 ms / 175 ms | 156 / 231 ms | 165 / 251 ms | connect 20 ms | connect 10 ms |

FTS5 built inline during the load (100k) took 1.05 s against 0.98 s for load + `rebuild`: no real difference.
Bun 1.3.14 at 100k: SQLite within ±30% of Node on every query; PGlite loads faster (240k rows/s) and uses less
RAM (429 MB query process); query times the same order as Node.

### Queries at 1M, p95 ms (Node 24; 20 runs, 20 different word pairs)

SQLite OR numbers come from the "sqlite rerun" section at the end (same corpus, rebuilt); its OR row counts with
filters match the Postgres ones exactly (17.1 small chat, 19.6 sender), which cross-checks all three engines.
**The rare-word AND rows are a best case**: the generator draws words independently, so two ~1% words almost
never meet in one message (0.1–1.3 rows returned with a filter). Real chats have correlated words, and an
empty AND result would send the user to the OR fallback — so the OR column is the realistic cost for rare words.

| query | SQLite AND | SQLite OR | PGlite (OR) | Docker PG (OR) |
|---|---|---|---|---|
| 2 words ~1% df, all | 1.6 | 42 | 2.5 | 1.1 |
| + big chat (500k msgs) | 1.3 | 39 | 10.5 | 1.9 |
| + small chat (1,996 msgs) | 0.7 | 26 | 80 | 46 |
| + last 30 days | 1.1 | 25 | 9.0 | 3.9 |
| + sender (3,808 msgs) | 1.0 | 31 | 39 | 20 |
| big chat + last 90 days | 0.7 | 26 | 10.7 | 6.2 |
| 2 common words (5–15% df), all | 24.5 | 187 | 4.2 | 3.3 |
| + big chat | 22.3 | 157 | 42 | 38 |
| + small chat | 16.2 | **109** | **298** | **150** |
| + last 30 days | 16.7 | **104** | 46 | 9.4 |
| + sender | 15.9 | **102** | 86 | 27 |
| big chat + last 90 days | 17.9 | **115** | **107** | 65 |
| 3 words, all | 4.4 | 151 | 3.6 | 1.9 |
| fuzzy (worst of 4; correction + search) | 15.0 (empadronamento) | | 3.7 | 3.5 |
| accent "València" | 1.0 | | 0.7 | 0.3 |
| Cyrillic "счёт" | 0.5 | | 0.7 | 0.3 |

### Fuzzy recall (both sizes, all three engines)

| typo | corrected to | truth 100k / 1M | recall | precision |
|---|---|---|---|---|
| Valenca | valencia (also matches València, VALENCIA) | 85 / 954 | 100% | 100% |
| empadronamento | empadronamiento | 19 / 113 | 100% | 100% |
| Ptsharev | ptsarev | 9 / 53 | 100% | 100% |
| whatsap | whatsapp | 130 / 1,344 | 100% | 100% |

Same result in every engine and size: the correction is done by the same JS code over the same vocabulary. The
synthetic corpus has no deliberate near-neighbour words (e.g. "valence"), so precision here is an upper bound.

### 10M

Not run. Estimate from 1M: SQLite ~8 GB and ~5 min build; PGlite ~16 GB and ~8–9 min; Docker ~17 GB. Load time
passes the gate (1M builds took ~30 s and ~60 s), disk does not: tmpfs had 14 GB free and it is RAM (5–7 GB free),
so 3× the estimate is far out of reach.

## Verdict

**It depends on one product decision: must every word match (AND), or is it BM25 over any word (OR)?**

- **AND by default → SQLite FTS5.** Every typical filtered query at 1M is ≤ 25 ms p95, fuzzy ≤ 15 ms, accent and
  Cyrillic ≤ 1 ms. The OR fallback (when AND finds nothing) is ≤ 42 ms p95 for rare words, but 100–190 ms p95 for
  two common words. Cost: 806 MB per 1M messages (about 1.5× the text and its normalized copy), ~30 s to build
  from scratch, ~150 MB RSS to query, 0.6 ms to open (175 ms from process start to first answer, mostly Node).
- **OR ranking → pg_textsearch wins the unfiltered case** (4 ms vs SQLite's 187 ms for common words: block-max WAND
  prunes to the top 20, FTS5 scores every match). But **with filters neither Postgres build meets 100 ms**:
  small chat + common words is 298 ms p95 in PGlite and 150 ms in native Postgres. PGlite also costs 2× the disk,
  ~850 MB RSS to hold the database open, 165 ms open, one process per data directory, and the correctness bug below.
- So **no engine meets < 100 ms p95 on every OR query with filters at 1M**. SQLite is closest (102–115 ms on the
  worst class, ≤ 42 ms on typical words) and is the only one that meets it everywhere under AND.

Where the bottleneck is:

- **Ranking / index design (both engines):** filters are not part of any full-text index. FTS5 must score every
  match, then join and filter (common words = ~100k matches → 16–25 ms). pg_textsearch walks its ranked list and
  drops rows that fail the filter; for a 0.2% chat it reads thousands of ranked rows before 20 pass (Docker
  native also hits 150 ms p95, so this is the **index/query shape, not WASM**).
- **WASM:** PGlite is 2–3× slower than native Postgres on the same plans (e.g. sender 86 vs 27 ms, BM25 build
  18.9 vs 8.0 s, load 139k vs 463k rows/s). Real, but secondary to the shape above.
- **Query planner:** SQLite with a plain `JOIN` picked the btree and ran MATCH per row (199 ms at 100k); `CROSS
  JOIN` fixes it. Postgres chose the post-filtered BM25 scan for the small chat at 1M (bitmap pre-filter at 100k).
- **Schema:** 1M messages in **one** chat was not measured (the biggest was 500k). With FTS5 a chat filter on a
  chat that holds most rows costs the same as no filter, so it should stay near the "all" numbers; the risk is
  the opposite case — tiny chats in a 10M corpus, where FTS5 still scores all global matches (inferred: ~10×
  the 1M numbers for common words, i.e. 150–250 ms). Mitigation to test: `rowid`-range or per-chat
  prefix/column tricks, or a second FTS table for small chats.
- **Fuzzy:** cheap everywhere (≤ 15 ms); SQLite's own trigram table is the slowest part for long words (GROUP BY
  over long posting lists: 11.6 ms for "empadronamento"). The vocabulary had 523k terms at 1M.
- **I/O:** not measured (tmpfs).

**PGlite correctness finding:** when a btree pre-filters rows, pg_textsearch 1.3.1 in PGlite returns
**non-matching rows with score 0** (337 of 400 returned rows in the small-chat test). Native 1.4.0 does not.
Any PGlite use must filter `score < 0`.

## The real store (`store.ts`), before phase 1 changes it

Storage phase 1, item 5: the same corpus loaded through `openStore` and `saveMessages` into a schema 5
file — one account per source, a chat per corpus chat, a sender identity per corpus sender, batches of
1,000 per chat. This is the baseline items 6–8 compare against. Measured 2026-09-30 on the machine above.

| path | runtime | N | batching | load | index | disk | peak RSS |
|---|---|---|---|---|---|---|---|
| store | node v24.19.0 | 100,000 | batches of 1000 per chat | 8,157 rows/s (12.26 s) | FTS by triggers, inline | 98 MB | 664 MB |
| store | bun 1.3.14 | 100,000 | batches of 1000 per chat | 10,481 rows/s (9.54 s) | FTS by triggers, inline | 98 MB | 315 MB |
| store | node v24.19.0 | 1,000,000 | batches of 1000 per chat | 7,614 rows/s (131.34 s) | FTS by triggers, inline | 937 MB | 1545 MB |

About 12 times slower than `sqlite.ts` loading inline (94,798 rows/s at 100k). Per message the store
upserts the sender's identity and `account_identities`, looks the message up before it writes, and its
message index is trigram (migration 5), not `unicode61`. Where the time goes is not measured yet.

## The real store after the message writes moved to Drizzle

Lane A slice 4 against the store just before lane A (`0e32cc2`, schema 11, hand-written SQL), same corpus,
same machine, 2026-09-30. At 100k the two builds ran alternately, four rounds each; at 1M once each.

| build | N | load | disk | peak RSS |
|---|---|---|---|---|
| hand-written SQL | 100,000 | 6,867 rows/s (mean of 7,028 · 6,834 · 6,895 · 6,710) | 126 MB | 530 MB |
| Drizzle, per-message statements prepared once | 100,000 | 7,942 rows/s (mean of 8,349 · 7,519 · 7,884 · 8,015) | 126 MB | 348 MB |
| hand-written SQL | 1,000,000 | 6,900 rows/s (144.93 s) | 1218 MB | 1376 MB |
| Drizzle, per-message statements prepared once | 1,000,000 | 9,131 rows/s (109.52 s) | 1218 MB | 1138 MB |

Faster, not slower: the hand-written store compiled every statement on every call, and the port
prepares the lookup, insert, update and attachment upsert once per store. Built per call instead,
Drizzle cost about a quarter of the load rate (measured on the identity queries alone, slice 2).
The schema 5 numbers above are not comparable: versions 6–11 added columns and triggers since.

## Search through the real store, after the reads moved to Drizzle

Lane A slice 6, `store-search.ts` on the 1M store file above (schema 11, trigram index), Node 24,
2026-10-01. Each query runs through `openStore().search` and as the same SQL raw through `node:sqlite`,
taking turns at going first; 40 samples a class, warm cache.

| query | store p50 ms | store p95 ms | raw SQL p50 ms | raw SQL p95 ms |
|---|---|---|---|---|
| 2 words ~1% df — all | 2.96 | 6.32 | 2.70 | 5.60 |
| 2 words 5–15% df — all | 14.4 | 37.7 | 14.1 | 36.9 |
| 3 words — all | 3.32 | 7.75 | 3.45 | 7.60 |

Drizzle, the row mapping and the async interface add 0.3 ms or less at p50 and under 1 ms at p95 here;
an earlier run of the same script was noisier at p95 (up to 4 ms on the common words, and the other way
on the rare ones). The store before lane A, hand-written SQL, run the same way: 2.61 / 5.43, 15.3 / 37.6,
3.41 / 7.67 ms (p50 / p95). `sqlite.ts` at 1M answers in 0.5 / 1.6, 11–14 / 25–28 and 1.6 / 3–4.4 ms,
on its own schema (unicode61 index, BM25), so the gap to it is the index, not the store.
