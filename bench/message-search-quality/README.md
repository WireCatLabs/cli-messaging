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
