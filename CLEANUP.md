# Cleanup

- `scripts/parity-convert.ts` — the one-off rewrite of `parity.json` into the N-CLI shape; delete once no open branch edits the old shape (feat/parity-n-clis). 2026-10-01
- `bench/stemming/data/` (gitignored, 230 MB in the stemming-bench worktree) — UD treebanks, Snowball build and test vocabularies; `download.sh` refetches them. Remove once the stemming decision is made. 2026-10-04

- 2026-10-05: `/tmp/search-vector-scan-EuiCv4` — synthetic SR-6 1M-vector benchmark store (~1.8 GB); report committed under `bench/search-quality/`, remove after owner confirms.

- 2026-10-05: `../cli-messaging-wt-search-thread-context` — context implementation worktree; removed 2026-10-05 after merge and owner confirmation.

- 2026-10-07: `../cli-messaging-wt-server-search-handoff` — worktree of the server-search handoff, on the merged branch `docs/server-search-plan`; not created by the server-search session, so left for the owner.
- 2026-10-07: `../cli-messaging-wt-server-search-fix` — follow-up worktree for #691; remove with its branch after the merge.
