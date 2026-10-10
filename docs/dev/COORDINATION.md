# Coordination between parallel sessions

Several sessions work on cli-messaging, tg-cli and max-cli at once. This page is what they share.

## Store migrations

**The next free migration number is 30.** Take it by editing this line in a pull request of its own,
merged before the migration: the runner skips every version at or below the file's, so two branches
holding the same number would leave one migration unapplied on stores that ran the other.

Migration 29 is reserved for the bounded direct-reply search index by `feat/combined-search`.

## Releases

- Each session releases its own merged work: `git fetch`, `npm view`, a `chore: release` pull request
  that raises the version from what npm really has, then `bin/release`.
- `bin/release` in every repository takes one machine-wide lock (`$XDG_RUNTIME_DIR/leemour-release.lock`),
  so only one release of any package runs at a time on this machine. tg-cli and max-cli also refuse a
  release within two hours of their last one; cli-messaging has no such gap.
- To try an unreleased cli-messaging in tg-cli first, use `bin/try-messaging` in the tg worktree, never a
  committed `file:` path.

## Who owns what

Open pull requests are the source of truth for claimed work (`gh pr list` in each repository). A plan
for open work lives in `docs/dev/` beside this page; a plan whose work is merged is deleted.
