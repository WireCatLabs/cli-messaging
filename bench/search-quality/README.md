# Conversation search quality and vector scan

Entirely synthetic: 24 labelled conversations, 48 messages across three interleaved groups,
108 distinct queries (54 dev / 54 held-out), 48 answerable and six no-answer queries per split.
Exact invented names and ticket ids, paraphrases, Cyrillic/Latin, brief confirmations and a
media-only conversation are included. The media-only labels intentionally count as misses:
there is no searchable text or chunk. Group messages are interleaved; explicit reply ids preserve
the gold conversations. The runner asserts one built conversation per labelled document.

The word-speed generator in [bench/search](../search/results.md) uses random vocabulary and cannot
supply semantic relevance labels; these dialogues are authored and committed in
[corpus.json](corpus.json), with the same synthetic-only policy. No real account is opened, no
network request is made, and no model is downloaded. Each run creates its own temporary SQLite
store; the real cached e5-small files are read and their hashes checked against the pinned catalogue.

## Reproduce

At the repository root, after the shared model has already been installed:

```sh
pnpm build
pnpm exec tsc -p bench/search-quality/tsconfig.json
node bench/search-quality/run.ts > bench/search-quality/results.json
node bench/search-quality/scan.ts > bench/search-quality/scan-results.json
```

The scan writes about 1.8 GB into a new temporary store. Both scripts keep their stores for
inspection; removal is a separate cleanup step. Real-model work runs outside `pnpm test` because
its sandbox intentionally hides the shared cache.

## Method

Use production conversation building, chunking, embedding, word retrieval and vector retrieval.
The runner measures words by the same service with its model cache pointed at an empty directory;
meaning by `nearestConversations`; hybrid by rank fusion with k=60. It asserts the measured
selected-floor ranking equals the production hybrid service, including ties. It never thresholds
RRF values. Vary cosine before fusion, compacting meaning ranks after filtering.

All fixed floor candidates and all raw rankings are in [results.json](results.json). Choose on dev
only: maximize hybrid F1 minus no-answer query hit rate, subject to preserving unfloored dev
hybrid recall. Report held-out numbers afterwards; they do not select the floor. This is a small
synthetic holdout over queries on a shared corpus, not a blinded external evaluation or evidence
for every language/model/domain.

Recall@5 and MRR are macro averages over answerable queries. Precision@5 divides by five even
when fewer hits are returned. Each query labels one relevant conversation, so its maximum
precision@5 is 0.2. No-answer hits/rate are reported separately over six queries per split;
MRR is zero when no relevant result is returned. Every result must map to a labelled document.

## Measured results

2026-10-05T16:27:53.886Z; AMD Ryzen AI 9 HX 470 w/ Radeon 890M, 24 logical threads, 30.0 GiB RAM, linux 7.0.0-34-generic, v24.19.0. One real e5-small session on eight threads. Load start/end: [2.28, 2.25, 2.88] / [2.28, 2.25, 2.88]. Pinned model file hashes, corpus hash and measured production JS hash are recorded in the JSON.

| Split | Mode | Cosine floor | Recall@5 | Precision@5 | MRR | No-answer hits | No-answer query hit rate |
|---|---|---|---|---|---|---|---|
| dev | words | none | 0.708 | 0.142 | 0.614 | 0 | 0.000 |
| dev | meaning | none | 0.958 | 0.192 | 0.958 | 30 | 1.000 |
| dev | hybrid | none | 0.938 | 0.188 | 0.827 | 30 | 1.000 |
| test | words | none | 0.646 | 0.129 | 0.606 | 0 | 0.000 |
| test | meaning | none | 0.938 | 0.188 | 0.903 | 30 | 1.000 |
| test | hybrid | none | 0.896 | 0.179 | 0.769 | 30 | 1.000 |
| dev | words | 0.8 | 0.708 | 0.142 | 0.614 | 0 | 0.000 |
| dev | meaning | 0.8 | 0.938 | 0.188 | 0.938 | 10 | 0.667 |
| dev | hybrid | 0.8 | 0.958 | 0.192 | 0.938 | 10 | 0.667 |
| test | words | 0.8 | 0.646 | 0.129 | 0.606 | 0 | 0.000 |
| test | meaning | 0.8 | 0.875 | 0.175 | 0.840 | 9 | 0.667 |
| test | hybrid | 0.8 | 0.875 | 0.175 | 0.825 | 9 | 0.667 |
| dev | words | 0.85 | 0.708 | 0.142 | 0.614 | 0 | 0.000 |
| dev | meaning | 0.85 | 0.292 | 0.058 | 0.292 | 0 | 0.000 |
| dev | hybrid | 0.85 | 0.750 | 0.150 | 0.666 | 0 | 0.000 |
| test | words | 0.85 | 0.646 | 0.129 | 0.606 | 0 | 0.000 |
| test | meaning | 0.85 | 0.208 | 0.042 | 0.208 | 0 | 0.000 |
| test | hybrid | 0.85 | 0.646 | 0.129 | 0.606 | 0 | 0.000 |

**Choose cosine strictly above 0.80 for local e5-small (384 dimensions).** Dev hybrid recall rises
from 0.938 to 0.958, MRR from 0.827 to 0.938, and no-answer hits fall from 30 to 10. Held-out recall
falls from 0.896 to 0.875 (one query); MRR rises from 0.769 to 0.825, and no-answer hits fall from
30 to nine. Four of six held-out no-answer queries still return a hit: this is a noise-reduction
floor, not proof that a returned conversation answers the query.

0.85 eliminates those false hits but drops held-out meaning recall from 0.938 to 0.208 and hybrid
recall to 0.646; it fails the dev recall constraint. Reject that higher floor. Do not apply 0.80
to unmeasured local/remote models: they only reject nonpositive cosine. Word-only matches remain
eligible at every floor, and readiness still describes index coverage, not match quality. The
synthetic zero-cosine regression now keeps the exact word match without unrelated meaning padding.
The floor applies to `conversations search` fusion; `conversations related` remains a neighbour
lookup with its existing semantics.

## Vector-index verdict

The [existing embedding measurements](../embeddings/README.md) found about 31 chunks/s and a
~140 ms scan at 42k chunks after the paging fix. [scan.ts](scan.ts) calls production
`nearestChunks` on the migrated schema: unique 384-dimensional unit vector rows, ten chunks per
conversation, account/current-build joins, paging, cosine, grouping and top-k sorting. Its synthetic
anchor messages do not model conversation hydration or freshness; inference is excluded. The
vectors differ deterministically and are not model output. This measures the exact scan kernel,
not full search latency, and uses no ANN library.

Scan date 2026-10-05T15:32:28.159Z, AMD Ryzen AI 9 HX 470 w/ Radeon 890M, v24.19.0; three calls at each size.

| Chunks | Conversations | Calls (ms) | Median (ms) | Load start / end (1m) |
|---|---|---|---|---|
| 100,000 | 10,000 | 456, 601, 454 | 456 | 14.48 / 13.8 |
| 300,000 | 30,000 | 1623, 1493, 1169 | 1493 | 13.8 / 12.94 |
| 1,000,000 | 100,000 | 20190, 13637, 4421 | 13637 | 17.6 / 23.12 |

**ANN is needed for interactive million-chunk search; not yet for the measured 42k–100k scale.**
With a proposed one-second scan budget, 300k chunks already exceed it (1.49 s median); the crossover
is roughly 200k chunks by interpolation, not an independently measured threshold. At 1M the median
is 13.64 s and even the fastest third call is 4.42 s. High shared-machine load and cache warming
explain the large spread; the recorded timings do not justify a precise throughput claim. Additional
query inference, freshness and hydration cannot improve these lower-bound scan costs. Schedule ANN
work when unfiltered eligible chunks reach ~200k, and treat ≥300k as demonstrated need. No new
dependency, index or migration is introduced here; bounded filters can still make exact scans useful.
