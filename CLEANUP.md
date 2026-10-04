# Cleanup

- `scripts/parity-convert.ts` — the one-off rewrite of `parity.json` into the N-CLI shape; delete once no open branch edits the old shape (feat/parity-n-clis). 2026-10-01
- `bench/stemming/data/` (gitignored, 230 MB in the stemming-bench worktree) — UD treebanks, Snowball build and test vocabularies; `download.sh` refetches them. Remove once the stemming decision is made. 2026-10-04
