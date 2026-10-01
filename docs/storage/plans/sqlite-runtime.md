# A SQLite the store can work with, on every setup

Plan, 2026-10-01. **Proposed, not approved.** The owner's brief (2026-10-01): «cli-messaging should ship
its own SQLite always since users can be on exotic setups, maybe make it a fallback — just ensure the
user gets their sqlite working and version not older than x».

Evidence labels as in the rest of this folder: **verified** has a `path:line` or a command that was run;
**measured** names the setup it ran on; **docs say** names the source; **inferred** is reasoning.

## 1. Goal

Whatever runtime and operating system the user has, the store either runs on a SQLite that can do
everything it needs, or refuses at once with a message that says what to install. It never fails
half-way with a raw SQLite error.

"Can do everything it needs" is a capability, not a version number: FTS5 with `contentless_delete`
(store version 12). Node 22.15 reports SQLite 3.49.1, newer than the 3.43 that `contentless_delete`
needs, and has no FTS5 at all (measured, below).

## 2. Current state

**Where the store's SQLite comes from** — measured 2026-10-01 in Docker (`node:sqlite`, then
`CREATE VIRTUAL TABLE … USING fts5(…, content='', contentless_delete=1)`), and on GitHub's macOS runners:

| Setup | SQLite | Store works |
|---|---|---|
| Official Node 22.0–22.15, 23.x (static) | 3.46.0–3.49.1, **no FTS5** | **no** — `openStore` fails with `no such module: fts5` (22.15.0, cli-messaging 0.83.0) |
| Official Node 22.16+, 24+ (static) | 3.49.1+, FTS5 | yes |
| Ubuntu 26.04 `nodejs` 22.22.1 (system library) | 3.46.1 | yes |
| Alpine 3.22 `nodejs` 22.23.2 (system library) | 3.49.2 | yes |
| Fedora 43 `nodejs` 22.22.2 (system library) | 3.50.2 | yes |
| Homebrew `node` (Homebrew's `sqlite`, docs say: Formula/n/node.rb, s/sqlite.rb) | 3.53.4 | yes (inferred from the formula) |
| Bun on Linux (embedded) | 3.53.0 | yes |
| Bun on macOS 14, 15 (system library, docs say: Bun `nodejs-compat.mdx`) | 3.43.2 | yes |
| Bun on macOS 26 | 3.51.0 | yes |
| Bun on macOS 13 | unknown, probably < 3.43 (inferred) | **probably no** — writes fail on a version-12 file (SQLite 3.42.0, measured) |

Debian 12–13, Ubuntu 24.04 and Alpine 3.20 ship Node below 22 and are out of scope already.

**The store does not check.** `openCache` (`src/store/open.ts:14`) opens whatever the runtime has;
`openStore` runs the migrations on it. On Node 22.15 the very first migration fails (it creates
`messages_fts`, `src/store/migrations.ts:155`) — this is older than version 12. `engines.node` is
`>=22` in cli-messaging, tg-cli and max-cli (`package.json:13` each).

**Version 12 is published** (cli-messaging 0.83.0). tg-cli pins 0.82.0 and max-cli 0.79.0, so no user
has it yet; the next tg-cli bump brings it.

**What can and cannot be swapped.**

- Official Node links SQLite statically: nothing outside the process can replace it (inferred from
  `ldd`, which shows no `libsqlite3`).
- Distribution Node links `libsqlite3.so.0`: starting it with `LD_LIBRARY_PATH` pointing at our build
  replaces it (measured: Ubuntu 26.04 Node reported our 3.42.0). Our build needs Node's feature set
  (FTS3/5, SESSION, PREUPDATE_HOOK, COLUMN_METADATA, RTREE, GEOPOLY, RBU, DBSTAT_VTAB, MATH_FUNCTIONS),
  or Node exits at start-up on a missing symbol (measured twice).
- Bun on macOS loads the library `Database.setCustomSQLite(path)` names, if called before the first
  database is opened (docs say: Bun `runtime/sqlite.mdx`). On other systems that call does nothing.
- An install script cannot fetch it: Bun does not run dependencies' install scripts unless the user
  trusts the package (docs say: Bun `guides/install/trusted.mdx`).

## 3. Decisions made here

**R1 · A capability check before every store opens.** `openStore` runs, on `:memory:` with the same
driver, the statement version 12 needs; if it fails, it throws a `CliError` before `migrate`:

> This SQLite (3.49.1, Node 22.15.0) has no full-text search, which the message store needs.
> Update Node to 22.16 or newer, or run under Bun.

The message names what it found and the one thing to do, per runtime. It is checked once per process.
It replaces the raw `no such module: fts5` and `unrecognized option: "contentless_delete"`.

**R2 · `engines.node` says what works**: `^22.16.0 || >=24` in all three packages. npm only warns on
it; R1 is the guard. The user pages (`docs/installation.md` in max-cli, the README in tg-cli) say
"Node 22.16 or newer".

**R3 · Bun on macOS always uses our SQLite.** A package `@leemour/cli-messaging-sqlite-darwin` holds one
universal `libsqlite3.dylib` (arm64 and x86_64), built in our CI from the official amalgamation with
Homebrew's flags, `-mmacosx-version-min=13.0` (Bun's own minimum, docs say: Bun
`scripts/build/config.ts`). cli-messaging lists it under `optionalDependencies`; its `os: ["darwin"]`
keeps it off other systems (docs say: Bun skips packages whose `os`/`cpu` do not match; npm and pnpm do
the same, which is how esbuild ships its binaries — inferred). The Bun driver calls `setCustomSQLite` with it on macOS, every time — so the macOS version
stops mattering. If the package is missing (an install that skipped optional packages), the system
library is used and R1 refuses if it is not good enough.

Why one universal library and not two packages: one file to build and publish; the
cost is about twice the size of one architecture, a few MB (inferred).

**R4 · No library swap for distribution Node** (recommended; NEED below). Every distribution measured
already passes R1. Swapping needs a re-exec at the very start of `tg`/`max`, because the store opens
in the middle of a command — after a message may already have been sent, and a re-exec there could
send it twice. It also leaks `LD_LIBRARY_PATH` into child processes, and our build must stay as new as
every distribution's. R1 still gives those users a clear message.

**Where "always" stops.** Official Node 22.0–22.15 and 23.x cannot be given another SQLite inside the
process. A WebAssembly SQLite could run there, but several processes share `messages.db` (tg, max,
`mcp`, `serve`), and WebAssembly file systems have no shared-memory WAL or reliable locking across
processes — that risks the owner's system of record. For those users the answer is R1's message:
update Node.

## 4. Work items

One PR each, based on `main`.

1. **R1 + R2** — the check in `openStore`, the messages, `engines` in cli-messaging; a test with a
   driver that fails the check; a CI job on `node:22.15.0-slim` that asserts the message. Release.
   Then `engines` and the user pages in tg-cli and max-cli with their next bump.
2. **R3, the library** — a workflow that builds the universal dylib on a macOS runner, asserts with
   `vtool -show-build` that its minimum macOS is 13.0 and that it has both architectures, and publishes
   `@leemour/cli-messaging-sqlite-darwin` (by hand the first time, after the owner's yes).
3. **R3, loading it** — the Bun driver calls `setCustomSQLite` on macOS; a permanent CI job on macOS
   runners (14, 15, 26, and an Intel runner if GitHub still has one) asserts that Bun reports *our*
   SQLite version, and runs the store's tests under Bun.
4. **Upkeep** — `bin/release` checks that the dylib's SQLite is not older than the newest one the CI
   matrix saw; a SQLite update is a new version of the library package.

## 5. Test plan

- R1: a driver whose FTS5 statement fails → `openStore` throws the message, `migrate` never runs, the
  file is not created or changed. Real check on `node:22.15.0-slim` and `node:22.16.0-slim` in CI.
- R3: on each macOS runner, under Bun, `select sqlite_version()` equals the library's version; the S1
  table and `integrity-check` work; `pnpm smoke:bun` passes. `vtool` shows `minos 13.0` for both
  architectures — the only check of macOS 13 we can run without a Mac on 13.
- Without the optional package (`--omit=optional`): Bun on macOS uses the system library and R1 decides.

## 6. Open questions

1. **NEED-481**, as answered: our SQLite always where it can be swapped (Bun on macOS), the check
   everywhere. This plan is that answer; approve or correct it.
2. **R4** — distribution Node, swap the library by re-exec (**A**), or only R1's message (**B**,
   recommended)?
