# Handoff — finish phase 5: search by meaning in serve and MCP, the parity rows, hybrid ranking, the measurement (2026-10-02)

**Superseded 2026-10-03** by [`phase-5-next.md`](phase-5-next.md).

**Done 2026-10-02:** all five items (#405, #406, #407, and the measurement). Left: the scan's paging (see
[the measurement](../../../bench/embeddings/README.md)) and max's `models text` row.

The trail, optional, grep by id: max-cli `docs_ai/journal/2026-10-02-storage-phase-5-plan.md`.

## 1. What this is

`@leemour/cli-messaging` is the shared half of tg-cli and max-cli, with one SQLite store for every
messenger. Phase 5 searches a group's conversations by meaning: `conversations embed` cuts each built
conversation into chunks and stores one vector per chunk text; `conversations search` embeds the query and
scans the vectors. A local model (e5-small, through our own WebAssembly runtime package) is the default; an
OpenAI-shaped API with the user's key is the option. Items 1–4 of the plan are built and released (0.101.0),
tg is on it (tg-cli #217). Left: keeping search warm in long-running processes, a few loose ends, then hybrid
ranking once phase 2's search service exists, and the measurement. Full picture:
[`../plans/phase-5.md`](../plans/phase-5.md).

## 2. Orient in one call

```sh
cd /home/leemour/Projects/AI/cli-messaging && git pull -q --ff-only && {
  echo "== plan §4 E3 (plain table), E7 (search), E9 (hybrid)"; sed -n '114,120p;149,168p' docs/storage/plans/phase-5.md
  echo "== plan §5 work items, with what is done"; sed -n '216,238p' docs/storage/plans/phase-5.md
  echo "== the service: resolve a model, then search"; sed -n '68,110p;181,205p' src/services/embeddings.ts
  echo "== the scan"; sed -n '96,160p' src/store/sqlite/vectors.ts
  echo "== how an MCP tool gets its store (one per call)"; sed -n '160,166p' src/mcp/tool.ts
  echo "== phase 2: ranking and its search service, which hybrid needs"; sed -n '244,247p;363,366p' docs/storage/plans/phase-2.md
  echo "== max's cli-messaging version (parity rows wait for it)"; git -C ../max-cli fetch -q; git -C ../max-cli show origin/main:package.json | grep '"@leemour/cli-messaging"'
  echo "== open PRs"; gh pr list --limit 10
} > ~/.cache/phase-5-orient.txt 2>&1
```

Then read `~/.cache/phase-5-orient.txt`. It shows: the three decisions that bound the rest of the work, the
work-item list with ✅/🟡 marks, how `search` opens the model and calls the store, the paged scan it runs,
that an MCP tool opens the store anew on every call, phase 2's ranking rule and the service hybrid ranking
plugs into, and whether max has bumped yet.

## 3. Read in this order (only if the orient output is not enough)

1. `src/services/embeddings.ts` — where a search loads the model (`resolve(...).open()`) and closes it: what a
   warm cache would keep.
2. `src/mcp/tools/conversations.ts:40-70` — `conversations_search`, the caller that runs again and again in one
   process.
3. `src/embeddings/embed.ts` — `openEmbedder`: what loading a model costs (tokenizer parse plus session,
   ~1 s and ~0.7 GB) and what `close()` releases.
4. `parity.json` rows `"conversations embed"`, `"conversations search"`, `"models text"` (search for the
   keys) — what turns from planned to present once both CLIs are on ≥ 0.101.0.
5. `bench/search/results.md` — the shape item 8's measurement copies; `bench/embeddings/README.md` does not
   exist yet.

## 4. Do

1. **Keep search warm in `serve` and `mcp`** (plan item 5, 🟡). Today each `conversations_search` call loads
   the model (~1 s) and reads every vector of the scope. Keep, per process, the open embedder per model and
   the scope's vectors per store path and model, and drop them when a `conversations embed` or a rebuild
   changes the chunks. Decision yours: cache the embedder only (simple, removes most of the cost) or the
   vectors too (the plan says both, E3); the embedder alone is the measured bulk of a one-shot search.
   A one-shot CLI process must still exit — whatever you keep is closed on every exit path (project
   constraint 4). Check: an MCP test calling `chat_conversations_search` twice opens the model once (count
   `openEmbedder` calls with a spy), and `pnpm test` passes.
2. **Say when a chat is embedded only with another model** (plan E7). `search` with the default model over a
   chat embedded with `openai:…` finds nothing silently. Name such chats on stderr (and in `--json` as a
   field). Check: a service test with one chat embedded under a second model key.
3. **Turn the parity rows from planned to present** once max-cli is on ≥ 0.101.0 (the orient output says). Set
   `"conversations embed"`, `"conversations search"` and `"models text"` to `"in": "all"`, give their options
   rows, run `pnpm parity:render`. Check: `pnpm vitest run src/parity` and, in CI, `main (tg)` and
   `main (max)` green. Until max bumps, leave them planned — not this session's to force.
4. **Hybrid ranking** (plan item 7, E9) — only after phase 2 item 6, "the search service", is merged (the
   orient output shows its plan line; check `git log --oneline -5 -- src/services/messages.ts`). Run the
   word search in the same scope, map hits to their conversations of the current build, merge with the
   meaning list by reciprocal rank fusion. Decision yours: k = 60 (the usual constant, plan E9) unless the
   item's small hand-written query set says otherwise. Check: a test over a synthetic chat where a word-only
   query and a meaning-only query each land first.
5. **Measure** (plan item 8): embed and search time at 100k messages through the real commands, Node and
   Bun, recorded in a new `bench/embeddings/README.md`. Synthetic corpus only (`bench/search/gen.ts`), written up like `bench/search/results.md`.

## 5. What bites

1. **A command group and its subcommands sharing an option**: commander gives the value to the group, so
   `embed status --chat 7` once refused every call. In `src/cli/messenger/conversations-command.ts` the
   group's action checks `--chat` itself (`chatOf`) and subcommands read options with `optsWithGlobals`.
   Keep that pattern for any new shared option, and test the subcommand path.
2. **A new shared command needs parity rows, planned until tg and max bump**: CI's `main (tg)` and
   `main (max)` run each CLI's main against this repo's `parity.json`. A planned command's options are not
   checked (since 0.103.0); a present one's are.
3. **The changelog moves under you**: releases are cut every couple of hours by any session. After every
   rebase, check that your entry is under `## Unreleased`, and that `Unreleased` has one `### Added`
   (`pnpm docs:check` refuses two).
4. **The worker-thread files cannot run in vitest** (they load `dist/embeddings/worker.js`): they are excluded
   from coverage and driven by `pnpm check:dist` under Node and Bun. Do the same for any new worker code.
5. **The model is not in CI**: tests use the tiny generated model in `src/embeddings/fixtures/tiny` (a
   5-word tokenizer and a lookup table, generator script beside it). Real-model checks are by hand:
   `~/.cache/cli-common/models/text/e5-small` is downloaded on the dev machine.
6. **e5-small is weak across languages**: an English chat did not answer the same question asked in
   Russian. Do not read a cross-language miss in a hand check as a bug; EmbeddingGemma does better.
7. **The secret scanner flags `tokenizer: <hex>`** as a key in Markdown. Word a hash line without the
   `name: value` shape rather than adding an exception.

## 6. Do not touch

- Phase 2's files — `src/store/sqlite/search*`, `src/store/sqlite/words.ts`, `src/search/` — another session
  builds phase 2; hybrid ranking calls its service, it does not edit it.
- max-cli's code and its bump — max's own session owns it.
- `docs/storage/requirements.md` — the owner's words, verbatim.
- `packages/onnx` — published as `@leemour/cli-messaging-onnx` 1.0.0; change it only for a new ONNX Runtime,
  and its CI publish needs a trusted publisher set on npmjs.com first (the 1.0.0 was published by hand).

## 7. Check

```sh
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm docs:check && pnpm build && pnpm check:dist && pnpm smoke:bun && bun scripts/check-dist.ts
```

Real-model check by hand (dev machine, e5-small downloaded): build and embed a copy of an IRC bench store as
in `bench/disentangle/README.md`, then `conversations search`. Never run it on the owner's real account.
