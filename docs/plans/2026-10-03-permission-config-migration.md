# Permission configuration migration

Status: implementation of the approved four-level permission plan's missing migration step.
The shared resolver already folds legacy readOnly/allow beneath explicit permissions, but the
config command has no migrate action. MAX's full cutover waits for this prerequisite.

Add pure migratePermissionConfig and config migrate --dry-run. Preserve effective levels for
personal/bot defaults and every named profile. Per-layer translation alone is unsafe: an inherited
allowed child can override a profile's replacement allow-list. Snapshot original effective maps,
remove legacy fields, and emit only overrides needed to preserve levels in kind scopes.
Keep canonical permission choices and every other setting. Remove mcpTools, which no longer
selects tools; profile permissions apply to agents. Refuse whole-file writes when PROFILE_LOCK
is set. Validate the input and transformed file before saving; preview/no-op never write.

Tests compare before/after resolved levels for every legacy word, both kinds, nested/default/flat
profile overrides and default critical ask permissions. Cover invalid input, extension settings,
missing/no-op files, idempotence, dry-run and profile-lock refusal. No messenger/store/session or
real config access. Lint/typecheck/coverage/docs/build/dist/Bun/CI and PR merge required. MAX runtime
adoption is separate; this change does not enable its new settings yet.
