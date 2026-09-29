# cli-messaging — working rules

The messenger-neutral half of tg-cli and max-cli, published as `@leemour/cli-messaging`. Start with
the one page that covers what you are about to touch:

- [`docs/dev/ARCHITECTURE.md`](docs/dev/ARCHITECTURE.md) — the modules, the store and its migrations,
  the command skeleton, who consumes it.
- [`docs/dev/CONVENTIONS.md`](docs/dev/CONVENTIONS.md) — max-cli's conventions, and what differs here.
- [`docs/dev/TESTING.md`](docs/dev/TESTING.md) — the sandbox, the coverage floor, no real waits.
- [`docs/plans/`](docs/plans/) — the platform proposal (the backlog is its §8) and the lanes plan.

## The constraints that shape everything

1. **Nothing here knows a messenger.** No provider library, no adapter; `biome.json` refuses them.
2. **The store is the owner's system of record.** Migrations are forward-only and cannot be undone.
   No test and no branch build may open the real file — `MESSAGING_STORE` points elsewhere.
3. **Other sessions work here at the same time.** Work in a worktree off `origin/main`, rebase before
   pushing, and announce a migration number in
   [the lanes plan](docs/plans/2026-09-29-parity-lanes.md#4-releases-while-lanes-run) before writing it.
4. **A change reaches tg-cli and max-cli only through a release.** Both pin an exact version.

## Comments

Sparse, and only *why*. No comment restating the line, no banners, no narrating the change.

## Deletions

Never delete or clean up mid-task. Record it and do the removals in one batch after the owner
confirms. Never kill a process by name — find the PID, confirm it is yours, kill that PID.

## Committing

Conventional commits. Before committing:

```sh
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm docs:check
```

A branch off `main`, in a worktree, and a pull request. A user-visible change gets a line under
`## Unreleased` in [`CHANGELOG.md`](CHANGELOG.md). `bin/release` publishes; when the version is
already taken it moves to the next free one and renames the changelog heading with it.
