# Message search ranking quality

This offline benchmark compares the production strict Lucene search (including its default
stemming) and legacy fallback chain through `searchStore`. It contains 2,616 invented messages
in nine chats, and 96 labelled queries: 40 answerable and eight no-answer per split. Each topic
has two useful messages and 300 newer distractors. The busy operations chat holds 1,600 topic
distractors plus 200 unrelated messages; eight topic chats each hold 102 messages.

The committed [corpus.json](corpus.json) is the evaluation input. [generate.py](generate.py)
reproduces it deterministically with no packages or network. No real account, messenger adapter,
model cache or network request is used. The runner opens an explicit new temporary SQLite file,
points `MESSAGING_STORE` and the model cache into that temporary directory, builds both indexes,
and closes the store in `finally`. It keeps the temporary files for inspection; removal is a
separate owner-approved cleanup task.

## Reproduce

From the repository root, with dependencies installed:

```sh
pnpm build
pnpm exec tsc -p bench/message-search-quality/tsconfig.json
node bench/message-search-quality/run.ts > bench/message-search-quality/baseline.json
```

The script fixes UTC for both dialects. It exits unsuccessfully for invalid labels, duplicate
message/query ids, incomplete indexes, unknown result ids, duplicate hits or a missing measured
query/mode. Every query produces numeric metrics in both modes; answerable metrics are null
only for no-answer queries. The aggregate reports every split, mode and category. Corpus, runner
and relevant production-file hashes identify what was measured; the temporary path changes per run.
The benchmark runs outside `pnpm test`; its own TypeScript check is required because the repository
lint and TypeScript configuration exclude this folder.

## Labels and limits

Queries cover whole words, typos, word beginnings, Cyrillic and Latin, phrases, sender/chat/date
filters, AND/OR, paraphrases, and absent/near-miss no-answer requests. Each query states its intent.
Grade 2 is the message answering the decision/policy question; grade 1 is its useful owner or
confirmation message. Templates, unanswered questions and rejected proposals are grade 0.
The sender-filter queries label only the grade-2 message because the confirmation has another sender.
All other answerable queries label both useful messages. No-answer requests have no labels.

Lucene `date:2026-10-02` is paired with legacy `after:2026-10-02 before:2026-10-03`.
Explicit Lucene AND is paired with legacy implicit conjunction. These are handwritten equivalents;
the runner does not reinterpret an unsupported dialect silently. OR is limited to the same
precedence-compatible shape in both parsers. The `exact` flag is not enabled: the Lucene baseline
measures the existing default strict service, with stems ready.

Dev topics are Aurora, Cedar, Север and Lumen; held-out topics are Harbor, Maple, Вектор and Prism.
The topic families and labelled messages do not overlap, but both are indexed in the same archive.
Templates and query categories are shared. This is a small synthetic holdout, not a blinded external
study or evidence of general multilingual quality. Held-out results are reported for baseline
transparency; future parameter choices must use dev only. A lexical reranker cannot reliably
recognize an agreed decision merely from shared topic words. Paraphrases remain explicit misses
in a lexical-only release; do not redefine their labels to inflate its score.

Recall@10 is the fraction of labelled messages in the first ten hits, macro-averaged over
answerable queries. MRR uses the first grade-1-or-2 hit within the returned ten (zero for a miss).
nDCG@10 uses gain `2^grade - 1` and a discount of `log2(rank + 1)`, normalized against the sorted
labels. No-answer false hits count all returned messages on no-answer queries, up to ten each;
query hit rate is the fraction of no-answer queries returning any hit. These are retrieval false
hits, not claims about an agent's eventual answer. Raw ids, labels, match types, scores and
corrections are retained in [baseline.json](baseline.json), without real messages.

## Baseline

| Split | Mode | Recall@10 | MRR@10 | nDCG@10 | No-answer false hits | No-answer query hit rate |
|---|---|---|---|---|---|---|
| dev | Lucene | 0.313 | 0.325 | 0.287 | 0 / 80 | 0.000 |
| dev | legacy | 0.388 | 0.425 | 0.354 | 80 / 80 | 1.000 |
| held-out | Lucene | 0.263 | 0.325 | 0.219 | 0 / 80 | 0.000 |
| held-out | legacy | 0.338 | 0.450 | 0.299 | 80 / 80 | 1.000 |

The strict matcher misses typos and word beginnings. Legacy recovers some, but its early successful
list prevents other matchers from contributing; broad any-word fallback fills no-answer pages.
Both can bury useful messages beneath exact keyword matches. Sender/date filters are easy controls
and achieve full recall; category reports prevent them from concealing poor unfiltered rankings.

## Combined lexical experiment

After building, run the separate dev evaluation:

```sh
pnpm exec tsc -p bench/message-search-quality/tsconfig.json
node bench/message-search-quality/combined.ts > bench/message-search-quality/combined-dev.json
```

It calls the internal production matcher directly without changing public `searchStore` defaults.
All 180 combinations of candidate depth, RRF constant, lexical reranking signal and chat cap are
measured on dev only. All returned rankings are scored against the unchanged corpus labels.
Explicit AND/OR/phrase query ids must match the strict production top ten exactly. The runner
never supplies query `intent` or relevance labels to the matcher.

Every tested configuration has dev recall@10 0.3625, MRR@10 0.375 and nDCG@10 0.3264, with zero
no-answer false hits. None meets the approved 0.45/0.50/0.40 gates. [combined-dev.json](combined-dev.json)
records each configuration, measured timing and hashes, and the diagnostic dev rankings. No
combined held-out result is produced when dev fails. The original baseline is preserved.
The [revised proposal](../../docs/dev/combined-search.md#measured-lexical-experiment-and-revised-proposal)
requests a semantic evaluation before public adoption. Timings are from this small corpus on a
shared machine; they are not release-scale latency evidence.

## Candidate recall and semantic ranking

[semantic.ts](semantic.ts) measures the lexical candidate pool before reranking. The original
corpus and labels remain unchanged. [questions.json](questions.json) adds eight answerable and four
no-answer questions on the existing dev topics, plus four fresh held-out topic families with 608
new synthetic messages and twelve questions. [generate-questions.py](generate-questions.py)
reproduces this supplement. Its input hashes are frozen before model inference and parameter selection.
Query `intent` and relevance labels are never supplied to either model.

Dev candidate recall is 0.4375 at depth 50, 0.7500 at 100, and 0.9000 at 300/500. Depth 300 is the
smallest tested pool reaching maximum recall. Every non-paraphrase category has full candidate
recall at that depth; paraphrases have zero. The pool size measures returned candidates from the
internal service, rather than the union of every raw matcher list.

To measure the already installed, pinned e5-small model:

```sh
pnpm build
pnpm exec tsc -p bench/message-search-quality/tsconfig.json
node bench/message-search-quality/semantic.ts > bench/message-search-quality/semantic-dev.json
```

The benchmark verifies the local model's hashes before opening it. e5-small cosine reranking
reduces original dev keyword recall@10 from 0.3625 to 0.2750, MRR from 0.3750 to 0.3000, and nDCG
from 0.3264 to 0.2674. On the additional answerable questions it improves ranking when supplied
manual topic anchors for retrieval, but every tested threshold preserving zero no-answer hits
reduces answerable recall to zero. No e5 held-out evaluation is performed because dev fails.

The second experiment uses the official
[mmarco-mMiniLMv2-L12-H384-v1 model](https://huggingface.co/cross-encoder/mmarco-mMiniLMv2-L12-H384-v1)
to jointly score query-message pairs. [reranker.json](reranker.json) pins an Apache-2.0 ONNX export,
its revision, tokenizer/config files and SHA-256 hashes. Its identity activation is retained:
scores are raw logits, not cosine or calibrated probabilities. The benchmark-only adapter is
[crossencoder.ts](crossencoder.ts); it uses the installed tokenizer and WebAssembly ONNX runtime,
checks input/output shapes and rejects overlength pairs instead of silently truncating them.

Model preparation is an explicit, separate network step, totaling about 136 MB. Use a directory
outside the real store and repository, then run the offline evaluation:

```sh
python bench/message-search-quality/prepare-reranker.py /tmp/message-search-reranker-1427fd6
MESSAGE_RERANKER_DIR=/tmp/message-search-reranker-1427fd6 \
  node bench/message-search-quality/semantic.ts --crossencoder > bench/message-search-quality/crossencoder-dev.json
```

The evaluation cannot download or install a model. Preparation and benchmark stores retain their
files for inspection; cleanup is a separate task. Both models score only bounded lexical candidates.
Explicit Boolean/phrase/AST requests retain the existing strict ranking. All parameters are selected
on dev; held-out inference happens only after the dev ranking/no-answer gates pass.

The question-form experiment deliberately separates two measurements: direct full-question Lucene
retrieval, which currently finds no candidates, and reranking a manually supplied topic shortlist.
Manual topic anchors are diagnostic inputs, not an implemented natural-language query parser.
These results do not establish end-to-end question search. Questions asking for an unknown auditor
provide harder no-answer controls than the original requests with absent topic words.

### Measured query-message ranking

[crossencoder-dev.json](crossencoder-dev.json) records the frozen model, depth 300, raw score floor
2 selected for the question diagnostic, exact hashes, per-query rankings, and both held-out reports.
Keyword requests use reranking without a score floor; their no-answer candidate pools are empty.
The question floor is fitted on dev only and is not a general answerability or confidence guarantee.

| Original query split | Mode | Recall@10 | MRR@10 | nDCG@10 | No-answer false hits |
|---|---|---|---|---|---|
| dev | Strict | 0.313 | 0.325 | 0.287 | 0 |
| dev | Legacy | 0.388 | 0.425 | 0.354 | 80 |
| dev | Combined + joint reranker | 0.525 | 0.553 | 0.477 | 0 |
| held-out | Strict | 0.263 | 0.325 | 0.219 | 0 |
| held-out | Legacy | 0.338 | 0.450 | 0.299 | 80 |
| held-out | Combined + joint reranker | 0.438 | 0.488 | 0.405 | 0 |

The original keyword held-out result beats both previous modes but misses the approved recall
0.45 and MRR 0.50 gates. nDCG and no-answer gates pass. No parameters are changed after reading
these results. The fresh question held-out diagnostic has recall 0.6875, MRR 1.0, nDCG 0.8660 and
zero false hits on four no-answer queries, using manual anchors. This small synthetic set does not
establish general answerability or a functioning full-question retrieval path.

The semantic experiment indexes both the original corpus and fresh supplemental messages. To
control for the changed archive, strict/legacy results on that same 3,224-message archive are in
[augmented-baseline.json](augmented-baseline.json); their original-query metrics equal the old
baseline. Reproduce that comparison without changing the original baseline file:

```sh
node bench/message-search-quality/run.ts --include-questions > bench/message-search-quality/augmented-baseline.json
```

The joint model scores about 10–12 ms per pair in these runs on eight WebAssembly threads, plus
roughly a second to load. Scoring 300 uncached pairs therefore costs about 3–4 seconds, exceeding
the proposed 250 ms latency gate. This is measured benchmark inference, not production p95 or
an optimized batch/native implementation. Exact-pair caching helps repeated identical requests;
it does not remove the cost of a new query. No public service/default or consumer version changed.
