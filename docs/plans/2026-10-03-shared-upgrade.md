# Shared package upgrade workflow

Status: implementation slice of the approved max/tg shared-code parity plan. Claim
`feat/shared-upgrade`: package upgrade service, CLI factory, exports/tests/docs only.

MAX `src/commands/upgrade.ts` and Telegram `src/commands/update.ts` duplicate the same
version/installer/installation decision tree over cli-core's update helpers. Telegram also
restarts managed servers after installation. Keep that host lifecycle port; do not introduce
provider names into the decision tree or add automatic MAX connections/restarts.

`upgradePackage` takes installer/latest/install/after-update ports and returns a structured
outcome. It installs only for an explicit upgrade, a newer version and a supported package manager;
`--check`, registry unavailability, unchanged versions and manual installers never install.
Installation and host lifecycle failures never trigger a retry. The CLI factory alone renders
progress, warnings and results. No real package manager, registry or account is used by tests.

Both consumers retain their previous result fields and gain a consistent `restarted` array,
empty when none restarted. Pair user docs before consumer implementation; then release the shared
export and adopt the same exact version in both CLIs. Preserve their existing update environment
and server policy. Validation includes two app descriptors, all no-op paths, one installation,
failure/no-retry, host restarts and machine stdout/stderr separation, then full repo gates.
