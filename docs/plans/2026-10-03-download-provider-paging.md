# Download provider paging

Approved shared-code parity continuation; the owner requested fixing feasible differences.
Claim: fix/download-provider-paging. Consumer blocked: MAX adoption of download --all.

Source: src/cli/messenger/download-command.ts hardcodes PAGE=100 and pause=1s;
Messenger.fetching already declares page/pause/orderBy. Use these defaults for remote history
and keep PAGE=100 for store reads. Add regressions for the generic fetching descriptor.
Update manifest for completed MAX download/evidence adoption and compatibility --output alias.
Validate lint/typecheck/coverage/docs/dist/Bun, release prerequisite, consumer exact pin and gates.
No provider-specific imports, account access or schema migration.
