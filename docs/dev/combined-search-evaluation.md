# Combined message search: evidence, pipeline and measurement

The public search is unchanged. The internal lexical service and local reranking experiments are
in draft PR [803](https://github.com/leemour/cli-messaging/pull/803). The
[design](combined-search.md) describes the pending transition; the
[benchmark README](../../bench/message-search-quality/README.md) links reproducible inputs, runners,
model pins and raw results. No experiment opens the real store or a messenger account.

## What the experiments establish

| Experiment | Evidence | What it contributes |
|---|---|---|
| Strict and legacy baselines | Strict avoids no-answer noise; legacy recovers spelling variants but fills no-answer pages | Separates matching coverage from noise |
| Independent lexical candidates and 180 ranking configurations | Dev recall 0.3625 with no-answer false hits zero; lexical signal variants do not improve the top ten | Retains useful forgiving retrieval without the broad fallback chain; simple lexical signals are insufficient on these fixtures |
| Candidate pool diagnostics | Dev candidate recall 0.4375/0.7500/0.9000/0.9000 at depths 50/100/300/500 | Most labelled messages can be retrieved before ranking; paraphrases are absent from the lexical pool |
| e5-small embedding cosine | Dev recall falls to 0.275; no question threshold both preserves answers and rejects all missing-fact hits | Rejects this tested embedding similarity as the final message ranker |
| Joint query-message reranker | Improves held-out recall, MRR and nDCG over both baselines, with zero no-answer false hits | Provides measured relevance ranking gains, with an expensive scoring stage |
| Question-form diagnostic | Fresh held-out MRR 1.0 and zero missing-fact false hits using manual topic anchors | Shows the value of explicit task wording; does not implement natural-language candidate retrieval |

The joint reranker's original held-out keyword results are:

| Search | Recall@10 | MRR@10 | nDCG@10 | No-answer false hits |
|---|---|---|---|---|
| Strict | 0.2625 | 0.3250 | 0.2192 | 0 |
| Legacy | 0.3375 | 0.4500 | 0.2993 | 80 |
| Combined + joint reranker | 0.4375 | 0.4875 | 0.4049 | 0 |

Recall increases by 17.5 percentage points over strict and 10.0 points over legacy. The same-archive
baseline controls for adding the supplemental synthetic messages. The reranker misses the agreed
recall 0.45 and MRR 0.50 gates and the latency gate. It is an improvement on this small synthetic
benchmark, not proof of general real-chat quality or a release-ready default.

## What retrieval, candidates, scoring and reranking mean

1. Parse the Lucene query and resolve account authority and hard filters.
2. Retrieve possible messages with the word/stem indexes, prefixes and spelling corrections.
   These messages are **candidates**: they passed retrieval eligibility, not a relevance judgment.
3. Deduplicate full message locators and merge the independently ranked lists using reciprocal
   rank fusion. Its score is computed from list positions, not by a neural model.
4. In the joint-model experiment, supply the query and each candidate message together to the
   model. It produces a numeric relevance score for that pair.
5. Sort the same candidates by their model scores and select the first ten. This is **reranking**;
   it cannot recover a message absent from the candidate pool.

The standard architecture is called **retrieve and rerank**, or **two-stage retrieval**. Our first
stage is lexical retrieval. A dense retriever would instead find nearby text vectors. A
**bi-encoder** independently embeds query and message and compares their vectors; a
**cross-encoder** processes the query and message jointly. The architecture and terminology are
explained in the [Sentence Transformers guide](https://sbert.net/examples/sentence_transformer/applications/retrieve_rerank/README.html).

The tested bi-encoder is the repository's pinned multilingual e5-small, using unit vectors and
cosine similarity. The better tested cross-encoder is
[mmarco-mMiniLMv2-L12-H384-v1](https://huggingface.co/cross-encoder/mmarco-mMiniLMv2-L12-H384-v1), an
Apache-2.0 multilingual model, pinned as a roughly 119 MB quantized ONNX file plus its tokenizer
and configuration. Its configuration specifies identity activation, so our scores are raw logits,
not percentages or calibrated probabilities. Keyword ranking does not apply a score floor;
question diagnostics use a dev-selected raw score floor of 2.

The current prototype executes one pair at a time on the CPU through the existing WebAssembly
ONNX runtime with eight threads. Its measured pair cost is about 10–12 ms: 300 fresh pairs cost
about 3–4 seconds. Loading the model costs roughly another second. These are separate stages;
the quoted scoring cost does not mean that the SQLite candidate lookup takes 3–4 seconds.
A different query requires new joint pair evaluations even when the same messages were previously
seen. An exact repeated query-message pair can reuse its score; there is no reusable standalone
message vector from this cross-encoder. Batch inference, native runtime and smaller-model options
need measurements before claiming a speed improvement.

## What 43.8 percent means

The labels are grade 2 for the actual answer, grade 1 for useful supporting context, and grade 0
for distractors. Existing binary recall and MRR count grades 1 and 2 as relevant. nDCG distinguishes
them using gains 1 and 3 respectively.

For each answerable query, recall@10 is the number of relevant messages in the first ten divided
by the number of eligible labelled relevant messages. We average these fractions equally across
queries (**macro average**). Finding one of two labelled messages gives 0.5 regardless of its
position inside the top ten. Finding both gives 1.0; finding neither gives zero.

The unrounded held-out value is 0.4375. From the existing saved rankings, the 40 answerable queries
break down into 11 retrieving both of two relevant messages, four retrieving their sole eligible
relevant message, five retrieving one of two, and twenty retrieving none:

```text
(11 × 1 + 4 × 1 + 5 × 0.5 + 20 × 0) / 40 = 0.4375
```

Thus the fraction of queries with at least one useful result is 20/40 = **50 percent**, and the
fraction retrieving all their relevant messages is 15/40 = **37.5 percent**. These are distinct
from macro recall 43.75 percent. They are descriptive calculations from the frozen rankings, not
new inference or a tuned result.

Ranking within the top ten is already measured:

- **MRR@10** averages the reciprocal rank of the first relevant result: first place contributes 1,
  second 1/2, tenth 1/10, and a miss zero. Here 19 queries have their first relevant hit at rank 1,
  one at rank 2, and twenty miss, giving `(19 + 0.5) / 40 = 0.4875`. This is not a success rate or
  an average rank. It ignores additional relevant hits after the first.
- **nDCG@10** discounts later positions, gives the actual answer more gain than supporting context,
  and normalizes each query against its ideal ordering. The mean is 0.4049. It is a ranking-quality
  score, not a percentage of successful queries.
- **No-answer false hits** are evaluated separately on queries with no relevant labels. Zero false
  hits on eight original held-out cases does not prove general answerability; the additional missing-
  fact cases use a different diagnostic and a dev-selected threshold.

The actual-answer distinction matters. Useful support ranks first in some cases where the answer
is absent. From the existing frozen keyword rankings: useful-hit Success@1 is 47.5 percent and
Success@10 is 50.0 percent. With grade 2 alone, answer Success@1 is 30.0 percent, answer Success@3
40.0 percent, answer Success@10 42.5 percent, and answer-only MRR@10 is 0.35625.

## Standard evaluation terms and proposed additions

These are **information retrieval (IR) evaluation** metrics. A test collection consists of a
corpus, queries and relevance judgments; the judgments are often called **qrels**. Saved ranked
outputs are **runs**. We use graded judgments, paired comparisons on the same queries, dev-only
parameter selection, held-out validation and ablations. References:
[Stanford IR evaluation](https://nlp.stanford.edu/IR-book/html/htmledition/evaluation-of-ranked-retrieval-results-1.html),
[ir-measures definitions](https://ir-measur.es/en/latest/measures.html), and
[TREC](https://trec.nist.gov/overview.html).

The following are proposals for the next report, not new release gates or implemented runner fields:

| Measure | Question it answers |
|---|---|
| Success@1/3/5/10, also called hit rate | Does at least one relevant message occur within the first k? |
| Grade-2 Success and MRR | How reliably and how early do we retrieve the actual answer? |
| Recall@1/3/5/10 and candidate recall@50/100/300 | How much labelled evidence survives each stage and cutoff? |
| nDCG@3/10 | Are the strongest answers ahead of weaker support and noise? |
| MAP@10 | How early do all relevant messages appear, using binary relevance? |
| Precision@k and returned-result precision | How much of the displayed list is useful? Specify the denominator for short lists. |
| All-relevant@k | Do we retrieve every labelled relevant message? This is a task diagnostic, not our recall definition. |
| No-answer query hit rate and false-hit count | How often does an unanswerable query produce hits, and how many? |
| Per-category and per-language breakdowns | Do aggregate gains hide typo, phrase, filter or Cyrillic regressions? |
| Stage p50/p95 latency and memory | What do lookup, model load and inference each cost, cold and warm? |

Fixed-denominator P@10 is useful only with context: most queries label just two messages, so even
a perfect top ten cannot exceed 20 percent precision when remaining slots are counted. The four
single-answer sender controls reduce this set's ideal macro P@10 to 19 percent. Returned-result
precision is different and can be 100 percent for a short list; report result count beside it.

For an agent looking for an answer, proposed headline measures are grade-2 Success@1/3/10, graded
nDCG@10, evidence recall@10, no-answer behavior and latency. Retain supporting-evidence metrics
alongside them rather than silently changing the old definition or relabelling the corpus.

More metrics alone do not create stronger evidence. There are only four topic families per
original split, with many correlated query variants. A larger fresh held-out set, varied numbers
of relevant messages, paraphrases, harder missing-fact negatives and independent label review are
more valuable than treating forty queries as forty independent samples. Future uncertainty estimates
should resample topic families, and report paired per-query gains/regressions and counts.

## Next work

Explain and settle the measurement definitions before modifying metric runners or tuning ranking.
Then derive the expanded dashboard from saved runs without repeating inference, and cross-check
standard metrics with a conventional evaluator using our explicit relevance/gain/cutoff settings.
Optimize CPU execution separately from retrieval depth: reducing depth from 300 to 50 already
loses labelled candidates before any reranker can help. Ranking changes require a fresh held-out
set; implementation-only speed changes require equivalence checks and separate timing measurements.
