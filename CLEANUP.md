# Cleanup

- `scripts/parity-convert.ts` — the one-off rewrite of `parity.json` into the N-CLI shape; delete once no open branch edits the old shape (feat/parity-n-clis). 2026-10-01
- `bench/stemming/data/` (gitignored, 230 MB in the stemming-bench worktree) — UD treebanks, Snowball build and test vocabularies; `download.sh` refetches them. Remove once the stemming decision is made. 2026-10-04

- 2026-10-05: `/tmp/search-vector-scan-EuiCv4` — synthetic SR-6 1M-vector benchmark store (~1.8 GB); report committed under `bench/search-quality/`, remove after owner confirms.
