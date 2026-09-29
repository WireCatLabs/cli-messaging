# Architecture

What the package is made of and where the seams are. The design and its reasons are in
[the platform proposal](../plans/2026-09-26-platform-proposal.md); this page is the map of what
exists. Written 2026-09-29 against 0.28.0.

## The one rule

**Nothing here knows a messenger.** A CLI's adapter translates its provider's objects into the
domain types, and `biome.json` refuses any import of `@mtcute/*`, `ws` or an adapter directory
under `src/`. What only one provider has travels in `providerMetadata`. The boundaries are in
[proposal §3](../plans/2026-09-26-platform-proposal.md#3-package-boundaries).

## Modules

| Export | Directory | What it holds |
|---|---|---|
| `.` | `src/domain/`, `src/render/`, `src/resolve.ts`, `src/terminal/` | the domain model (`models.ts`, types only), message locators, message rendering, name resolution that refuses rather than guesses, the secret prompt, the terminal QR code |
| `./store` | `src/store/` | the SQLite seam and the shared message store |
| `./sends` | `src/sends/` | the send guard: read-only, the allow-list, the recipient list, the hourly limit, the journal (never the text), the send id |
| `./cli` | `src/cli/`, `src/mcp/` | the command skeleton, the shared commands and the MCP server |

The README's table lists what each export offers; this page does not repeat it.

## The store

`openCache` (`src/store/open.ts`) opens `node:sqlite` under Node and `bun:sqlite` under Bun. Both
imports are dynamic: a static import of the other runtime's module fails at load time, before
anything can catch it. `pnpm smoke:bun` is what proves the Bun half.

`openStore` (`src/store/store.ts`) is the **one file for every messenger and account** — tg's
profiles and max-cli's bots write the same database, keyed by provider and account. Its path comes
from `storePath` (`src/store/path.ts`), the only place that turns `MESSAGING_STORE` into a path;
`mcp config` copies the variable into the entry it prints, so the server it starts opens the same file.

### Migrations

`src/store/migrations.ts` is append-only: forward-only, additive, numbered, and a migration that
reached anyone's file is never edited. `min_compatible` lets an older CLI keep using a file a newer
one migrated; only a breaking change raises it, and that is a major version of this package. The
rules are [proposal §4, Migrations](../plans/2026-09-26-platform-proposal.md#migrations).

⚠ **Announce a migration number before writing it.** Several sessions work in this repository at
once, and two of them taking the same number is a conflict no rebase fixes. The next free number
lives in [the lanes plan §4](../plans/2026-09-29-parity-lanes.md#4-releases-while-lanes-run); take
it by editing that line in a PR of its own, merged before the migration.

## The command skeleton

`run()` (`src/cli/program.ts`) never throws; it returns an exit code. It lifts a profile given as
the first word, resolves settings (flag → environment → file → default, `src/cli/settings.ts`),
records runs (`src/cli/runs/`) and closes what a command holds when `--timeout` ends it
(`src/cli/deadline.ts`).

A CLI describes its messenger once — a `Messenger` (`src/cli/messenger/context.ts`) with a
`connect` that returns a `MessengerAdapter` (`src/cli/messenger/port.ts`) — and gets the shared
commands, one file per resource in `src/cli/messenger/`. Two wrappers sit between a command and the
adapter: `observed.ts` times each call into the run record, `stored.ts` saves what was read. A new
adapter method is optional and reached with `capability()`; the wrappers pass through any method
they do not name.

The MCP server (`src/mcp/`) holds one connection for minutes and runs one call at a time; each tool
lives in `src/mcp/tools/<resource>.ts` and answers what the command's `--json` prints.

## Who consumes it

- **tg-cli** — the whole skeleton, the store, the guard and the MCP server; its adapter is under
  its own `src/telegram/`. To try an unreleased change: `bin/try-messaging` in a tg-cli checkout
  beside this one, never a committed `file:` path.
- **max-cli** — for now its bot accounts: the store, the guard and parts of the skeleton. Its
  personal account still keeps its own cache; moving it here is the proposal's Phase 4.

Both pin an exact version; a change here reaches them through a release and a bump in each.
