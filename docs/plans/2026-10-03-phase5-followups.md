# Phase 5 embedding follow-ups

Status, 2026-10-03: approved by the owner (option B); implemented and verified. Source read at
`origin/main` `f8b3ec8`. Scope: the three items in
[the handoff](../storage/handoffs/phase-5-next.md).

## Goal and current state

Give callers accurate worker guidance and a useful status estimate, and make the phase-5 plan describe
what shipped. `src/embeddings/pool.ts:30` divides eight threads among workers;
`bench/embeddings/README.md:31-34` measures three workers at only 1.04–1.1 times one worker, with
roughly twice the memory. `docs/storage/research/2026-10-02-embeddings.md:115-122` measures three
workers with four threads each at about 1.25 times the default eight-thread session; its 1.8 times
comparison uses a four-thread baseline. `src/embeddings/models.ts:46` still estimates e5-small at
15 chunks/s, although the 100k-message benchmark measured 31–34. The phase-5 plan's header at line 3
still says nothing is built, while its work items are complete.

## Decisions

Choose handoff option B: retain the current thread allocation and correct the guidance to the measured
1.04–1.1 times improvement and memory cost. This preserves resource use and avoids promising an
unmeasured improvement. Four threads per worker remain a future experiment, not a performance claim.
Use 31 chunks/s for e5-small, the slower measured single-worker result, with a comment naming the
Ryzen AI 9 HX 470 machine and 100k corpus. Leave EmbeddingGemma's unmeasured value unchanged.

## Work

1. Correct the pool comment and plan E12 in place, marking the correction and stating the comparison
   baseline. Point to the existing 100k measurements; distinguish them from the research grid.
2. Change e5-small's estimate to 31 chunks/s and adjust any status assertions that rely on the old rate.
   Add a changelog entry explaining that the estimate depends on hardware and input length.
3. Correct the plan header in place and link to its completed work items. Update the handoff status
   to identify the chosen option and completed checks.
4. Run the checks below, rebase before pushing, and open a PR. No release or consumer version bump.

## Verification

Run the embedding service tests, then lint, typecheck, coverage, docs check, build, Node dist check,
Bun smoke and Bun dist check. Exercise `embed status` against a synthetic chat through the benchmark
command harness. Since option B changes no thread allocation, reuse the existing 100k measurements;
no new benchmark rows or speed claims are justified. Do not open the owner's store or real accounts.

## Open questions

None. The owner approved option B and 31 chunks/s on 2026-10-03.

## Results

Lint, typecheck, coverage (1,042 passed, 2 skipped), docs check, build, Node dist check, Bun smoke and
Bun dist check passed. A synthetic 1,000-message chat produced 433 chunks; `embed status` estimated
14 seconds, matching `ceil(433 / 31)`. No thread-allocation change and no new benchmark rows.
