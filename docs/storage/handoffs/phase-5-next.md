# Handoff — phase 5 follow-ups: embed speed, the status estimate, the plan's header (2026-10-03)

**Correction 2026-10-03: all three follow-ups are complete in `fix/phase5-embedding-followups`.**
The owner approved option B: retain the thread split and correct the claims. The estimate now uses
31 chunks/s, and the phase-5 header records completion. Lint, typecheck, coverage (1,042 tests passed,
2 skipped), docs check, build, Node/Bun dist checks and Bun smoke passed. On a synthetic 1,000-message
chat, `embed status` returned 433 remaining chunks and 14 seconds (`ceil(433 / 31)`). The existing
100k benchmark remains the evidence for the unchanged allocation; it was not rerun. Implementation plan:
[`2026-10-03-phase5-followups.md`](../../plans/2026-10-03-phase5-followups.md).

Supersedes [`phase-5-rest.md`](phase-5-rest.md), whose five items are done. The trail, optional, grep by
id: max-cli `docs_ai/journal/2026-10-02-storage-phase-5-plan.md` and `2026-10-03-storage-phase-5-plan.md`.

## 1. What this is

`@leemour/cli-messaging` is the shared half of tg-cli and max-cli, with one SQLite store for every
messenger ([storage README](../README.md)). Phase 5, search by meaning, is built, released and
measured: [how it works](../search-indexes.md#search-by-meaning), [the plan](../plans/phase-5.md),
[the numbers at 100k messages](../../../bench/embeddings/README.md). **Correction 2026-10-03:**
the three follow-ups are complete as recorded above. The orientation and work list below describe the
pre-fix snapshot; they are retained as the task's history, not instructions for new work.

## 2. Orient in one call

```sh
cd /home/leemour/Projects/AI/cli-messaging && git pull -q --ff-only && {
  echo "== how workers split the threads (the cause of item 1)"; sed -n 6,32p src/embeddings/pool.ts
  echo "== research: sessions × threads, measured"; sed -n 102,122p docs/storage/research/2026-10-02-embeddings.md
  echo "== the 100k run: 1 vs 3 workers"; sed -n 27,40p bench/embeddings/README.md
  echo "== the speed the estimate uses (item 2)"; sed -n 38,48p src/embeddings/models.ts
  echo "== the plan's header (item 3)"; sed -n 1,4p docs/storage/plans/phase-5.md
  echo "== open PRs"; gh pr list --limit 10
} > ~/.cache/phase-5-next-orient.txt 2>&1
```

Then read `~/.cache/phase-5-next-orient.txt`. It shows:
- how `openPool` splits the threads between workers;
- the research grid of sessions × threads, with its verdict;
- the 100k-message run with 1 and 3 workers;
- e5-small's listed speed, which `embed status` uses for its estimate;
- the plan's stale header line.

## 3. Read in this order (only if the orient output is not enough)

1. `src/embeddings/pool.ts` — where `--workers` turns into sessions and threads.
2. `docs/storage/research/2026-10-02-embeddings.md:95-122` — which sessions × threads layouts were
   measured, and on what machine.
3. `bench/embeddings/README.md` — how to rerun the 100k measurement, and what it measured.
4. `src/services/embeddings.ts`, `status` — how the estimate is computed from `chunksPerSecond`.

## 4. Do

1. **Make `--workers` worth its memory, or say it is not.**
   - Now: `openPool` splits `min(8, cores)` threads between the workers, so 3 workers get 2 threads each.
     At 100k messages that was 1.04–1.1× one worker on 8 threads, for ~2.6–2.7 GB against 1.2 GB.
   - The research's best 3-worker layout gave each worker 4 threads (12 in all). Even that was only ~1.25×
     one session on 8 threads. Its "~1.8×" is measured against 4 threads.
   - **Decision yours:**
     - **A:** give each worker 4 threads, capped by the cores, and measure;
     - **B:** keep the split and correct the claims;
     - **C:** drop `--workers` from the help's suggestions.
     The data leans **A**, then whichever wins at 100k.
   - Either way, correct the "~1.8× at 3 workers" comment in `pool.ts` and plan E12 (`docs/storage/plans/phase-5.md`),
     in place, marked as a correction.
   - Check: `bench/embeddings/commands.sh <dir> 100000` (about 90 minutes; the embed lines are what count).
     It passes when the README's table holds the new rows and the comment matches them.
2. **Fix the estimate.**
   - `embed status` estimates e5-small at 15 chunks/s (`src/embeddings/models.ts:46`); the 100k run
     measured 31–34 on this laptop.
   - **Decision yours:** set the measured value, or a lower one for slower machines. I lean to the measured
     value, with a comment naming the machine. EmbeddingGemma's `2` is unmeasured; leave it unless
     you measure it.
   - Check: `pnpm vitest run src/services/embeddings.test.ts`, then `embed status` on any embedded chat.
3. **Correct the plan's header.** `docs/storage/plans/phase-5.md:3` still says "nothing is built". Correct
   it in place, marked as a correction, and point at the work items, all ✅.
   Check: `pnpm docs:check`.

## 5. What bites

1. **The accent-insensitive substring index (decision NEED-521 A in [`decisions.md`](../decisions.md)) is
   not a task yet.** It rides on the next store version that something else needs, so users wait through
   one rebuild, not two. The latest version is 14 (`drizzle/20261001231437_version-14-chunks`). Do not
   add a version for it alone.
2. **Workers and the child process are not in vitest.** `worker.ts`, `workers.ts`, `child.ts` and
   `process.ts` load from `dist`. `pnpm check:dist` and `bun scripts/check-dist.ts` drive them. A change to
   any of them needs `pnpm build` first.
3. **Memory numbers need a wait.** Read RSS 10 s after a close, not 1 s: the allocator returns memory
   late, and a 1 s read misjudged the worker path by ~0.3 GB.
4. **A long bench run can be cut by the laptop sleeping.** One one-shot read 16,659 s for that reason.
   Discard such a row; do not average it in.
5. **The changelog moves under you.** Releases are cut every couple of hours by any session. After each
   rebase, check that your entry sits under `## Unreleased`, with one heading of each kind
   (`pnpm docs:check` refuses two).

## 6. Do not touch

- `src/store/sqlite/vectors.ts`, `nearestChunks` — the `CROSS JOIN` is what keeps the scan at ~140 ms
  instead of 1.3 s at 42k chunks (bench README, "After the scan fix").
- `src/embeddings/process.ts`, `child.ts` and `warmEmbedders` — the MCP server's model, measured on both
  runtimes (search-indexes.md, "In the MCP server").
- `docs/storage/requirements.md` — the owner's words, verbatim.
- `packages/onnx` — published as `@leemour/cli-messaging-onnx`; change it only for a new ONNX Runtime.

## 7. Check

```sh
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm docs:check && pnpm build && pnpm check:dist && pnpm smoke:bun && bun scripts/check-dist.ts
```

The real model is on the dev machine (`~/.cache/cli-common/models/text/e5-small`); CI uses the tiny model
in `src/embeddings/fixtures/tiny`. Never run a measurement on the owner's real store: `commands.sh` builds
its own from the synthetic corpus.
