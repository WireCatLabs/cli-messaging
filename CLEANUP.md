# Cleanup

- `scripts/parity-convert.ts` — the one-off rewrite of `parity.json` into the N-CLI shape; delete once no open branch edits the old shape (feat/parity-n-clis). 2026-10-01
- 2026-10-10: `.worktrees/store-v2-schema` — worktree of store v2 W0 (`feat/store-v2-schema`); remove with its branch once merged into `store-v2`.
- 2026-10-10: `.worktrees/docs-ai-spec` — detached worktree of `max-cli/docs_ai` used to fix the store v2 spec from the sandbox; remove after its commit is on `docs_ai` main (`git -C ~/Projects/AI/max-cli/docs_ai worktree remove …`).
- 2026-10-10: the `/.worktrees/` line in this checkout's `.git/info/exclude` — added so worktrees under `.worktrees/` do not show as untracked; drop it if `.worktrees/` goes into `.gitignore` or stops being used.
- 2026-10-10: `.worktrees/reserve-100` — worktree of the version-100 reservation (`docs/reserve-store-v2-100`, PR #816); remove with its branch once merged.
