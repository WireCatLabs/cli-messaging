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
| `./services` | `src/services/` | the use cases, once each, that commands and MCP tools call — see [Services](#services) |
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

Versions 1–5 are hand-written in `src/store/migrations.ts` and frozen. From version 6 on, a
migration is SQL that `pnpm db:generate` writes into `drizzle/` from `src/store/sqlite/schema.ts`,
`pnpm db:bundle` copies into `src/store/sqlite/migrations.generated.ts`, and a row in
`src/store/sqlite/manifest.ts` numbers. Our runner (`migrate`) applies both, under `BEGIN IMMEDIATE`;
Drizzle's own migrator is not used. Every migration is forward-only, additive, numbered, and never
edited once it reached anyone's file — a test refuses a generated rebuild of a base table. `min_compatible` lets an older CLI keep using a file a newer
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

## Services

Five layers, each calling only the ones below it: the **domain** (`src/domain/`), the **adapters**
(each CLI's own, behind `MessengerAdapter`), the **ports** (`port.ts`, the store), the **services**
(`src/services/`) and the **interface** (the commands and the MCP tools). The layer design is in
max-cli's private `docs_ai/plans/2026-09-30-layers.md`; how this package built its half is
[the services plan](../plans/2026-09-30-services.md).

A service is a plain object made by a factory over `ServiceDeps` (`src/services/deps.ts`): the
messenger, `offline`, and a connection, a store and an account that are each opened on first use —
so a read from the store never connects. `servicesFor(deps)` hands out `messages`, `chats`, `people`,
`inbox` and `archive`. A command gets them from `withServices` on its context, which closes what was
opened; an MCP tool builds them over the session's connection with `onlineDeps`, or over the store
with `storedDeps`. Either way a command and its tool run the same method, and so answer the same
error for the same input. Each caller still parses its own input, so an error names `--since` in a
command and `since` in a tool.

**A CLI replaces a use case, not a command.** `Messenger.services` is an `Override`: it gets the
shared services and returns the ones it changes, and can call the shared method inside its own:

```ts
services: (base) => ({
  messages: { ...base.messages, list: (chat, window) => maxList(base.messages, chat, window) },
}),
```

Commands and MCP tools both see the replacement. To add a subcommand, a CLI calls `addCommand` on
the command a factory returns.

Saving what a read answered and timing each call stay decorators on the adapter (`stored.ts`,
`observed.ts`), stacked by `connected()` in `context.ts`, so no service can forget to save.

## Who consumes it

- **tg-cli** — the whole skeleton, the store, the guard and the MCP server; its adapter is under
  its own `src/telegram/`. To try an unreleased change: `bin/try-messaging` in a tg-cli checkout
  beside this one, never a committed `file:` path.
- **max-cli** — for now its bot accounts: the store, the guard and parts of the skeleton. Its
  personal account still keeps its own cache; moving it here is the proposal's Phase 4.

Both pin an exact version; a change here reaches them through a release and a bump in each.
