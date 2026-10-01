# A SQLite the store can work with, on every setup

Plan, 2026-10-01. **Approved by the owner 2026-10-01** (NEED-481 A, NEED-482 A, and "update Node" accepted
where SQLite cannot be swapped). R1 and R2 are built (#268, not yet released). The owner's brief (2026-10-01): «cli-messaging should ship
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

**R3 · One package of our own SQLite builds.** `@leemour/cli-messaging-sqlite` (a folder of this
repository, published on its own) holds the newest SQLite, built in our CI from the official
amalgamation, for every place one can be loaded:

- `darwin/libsqlite3.dylib` — one universal file (arm64 and x86_64), `-mmacosx-version-min=13.0`
  (Bun's own minimum, docs say: Bun `scripts/build/config.ts`);
- `linux-x64-gnu`, `linux-arm64-gnu`, `linux-x64-musl`, `linux-arm64-musl` — `libsqlite3.so.0`, the gnu
  ones built against an old glibc so they load on newer ones.

Each is compiled with Homebrew's flags plus what Node needs (FTS3/5, SESSION, PREUPDATE_HOOK,
COLUMN_METADATA, RTREE, GEOPOLY, RBU, DBSTAT_VTAB, MATH_FUNCTIONS); without the last group Node exits
at start-up on a missing symbol (measured). A small `index.js` returns the folder for the running
platform, or nothing.

Why one package and not one per platform: every new package name needs a first publish by hand and a
trusted publisher set on npmjs.com (docs say: npm trusted publishers are configured in the package's
settings, so the package must exist). One package is one such step; the cost is a few MB of libraries
for the other platforms in every install (inferred: about 1.5 MB each). It is versioned by SQLite, so
cli-messaging's daily releases do not rebuild binaries. It is a plain dependency of cli-messaging at a
version from npm — not `workspace:`, which `npm pack` would publish unresolved — and is listed in
`minimumReleaseAgeExclude` in cli-messaging, tg-cli and max-cli. It is on npm before the cli-messaging
change that depends on it merges.

The owner publishes it once by hand as an empty `0.0.0` (no binaries), so the trusted publisher can be
set on npmjs.com; every version with libraries is published from CI, with provenance — no compiled
library ever leaves a laptop.

**R4 · Bun on macOS always loads it.** The Bun driver calls `Database.setCustomSQLite` with the dylib
once, before the first database opens — R1's `:memory:` check included, since Bun refuses a second,
different path — so the macOS version stops mattering. If the file is
missing, the system library is used and R1 decides.

**R5 · Node that uses the system's SQLite is restarted on ours when the system's fails R1.**
`ensureSqlite()`, from a small entry `@leemour/cli-messaging/sqlite-runtime` that imports nothing heavy,
is the first thing `tg` and `max` run — before their program is imported (`await ensureSqlite()`, then
`await import("../program.js")`; a static import would load every module first).

1. A restarted process (marked by an environment variable) puts the user's `LD_LIBRARY_PATH` back into
   `process.env` and removes the mark, so programs it starts neither inherit our library nor skip their
   own check, and returns.
2. On Linux, if `/proc/self/maps` shows no `libsqlite3` (official Node, SQLite built in), return —
   no cost for most users.
3. Run R1's check on `:memory:`. If it passes, return.
4. Try our library first: a throwaway child, output captured, with our folder first in
   `LD_LIBRARY_PATH`, runs R1's check and reports `sqlite_version()`. Only if that passes and the version
   is ours does the restart happen — a library that does not load (a glibc older than ours, a Node that
   needs a symbol ours lacks, a binary whose search path ignores `LD_LIBRARY_PATH`) would otherwise crash
   the command before any of our code runs. (`ld-musl` in the maps picks the musl build.)
5. Restart: `spawn(process.execPath, [...execArgv, ...argv], { stdio: "inherit" })` — not `spawnSync`,
   which blocks the parent so it cannot pass signals on. The parent forwards SIGTERM, SIGHUP and
   SIGQUIT to the child, ignores SIGINT (the terminal sends it to both), and exits with the child's code,
   or re-raises the child's signal on itself. An MCP client or a `kill <pid>` stopping `tg mcp` stops the
   child too.
6. Otherwise return; R1 refuses when the store opens.

It runs before anything is read, sent or written, so the restart cannot repeat an action — which is
why it lives at the start of the command and not in `openStore`. Linux only: Homebrew's Node uses
Homebrew's SQLite, which is current (docs say: Formula/s/sqlite.rb, 3.53.4). Its cost: on a
distribution's Node 22, step 3 imports `node:sqlite`, so its experimental warning appears on every
command there, `--help` included; NEED-59 left that warning alone, and Node 24 prints none.

**Where "always" stops** (accepted by the owner). Official Node 22.0–22.15 and 23.x build SQLite into
the binary; nothing can replace it in the process. A WebAssembly SQLite could run there, but several
processes share `messages.db` (tg, max, `mcp`, `serve`), and WebAssembly file systems have no
shared-memory WAL or reliable locking across processes — that risks the owner's system of record. For
those users R1 says: update Node.

## 4. Work items

One PR each, based on `main`.

1. **R1 + R2** — done (#268): the check in `openStore`, `engines`, the CI job on Node 22.15.0.
2. **The libraries** — `packages/sqlite/`: a workflow that builds the five libraries (macOS runner;
   Linux x64 and arm64 runners, gnu in an old-glibc container, musl in Alpine), checks the dylib with
   `vtool -show-build` (minimum macOS 13.0, both architectures) and each `.so` for Node's symbols, and
   packs the package. Assertions: the dylib re-signed (`codesign -s -`) after any strip or `lipo` and
   `codesign -v` passes, and an arm64 runner loads it from the packed `.tgz`; each gnu `.so`'s highest
   `GLIBC_` symbol version (`objdump -T`) is the floor we document; each `.so` exports every `sqlite3_*`
   symbol Node 22 and Node 26 import. `bin/publish-sqlite` publishes the empty `0.0.0` for the owner;
   CI publishes the rest.
3. **R4** — the Bun driver loads the dylib on macOS. A permanent CI job on macOS runners (14, 15, 26,
   and Intel if GitHub has it) asserts Bun reports *our* SQLite and runs the smoke test.
4. **R5** — `ensureSqlite()`; a CI job in Ubuntu 26.04 with the distribution's Node and an old
   `libsqlite3` (3.42, put first on `LD_LIBRARY_PATH`) asserts the command restarts on ours, the store
   opens, a child process sees the user's `LD_LIBRARY_PATH`, and `kill -TERM` on the parent ends the
   child.
5. **tg-cli and max-cli** — call `ensureSqlite()` first in `src/bin/tg.ts` and `src/bin/max.ts`;
   `engines`; the installation pages ("Node 22.16 or newer"); `minimumReleaseAgeExclude`.
6. **Upkeep** — a SQLite update is a new version of `@leemour/cli-messaging-sqlite`; its build refuses a
   SQLite older than the newest one the CI matrix met.

## 5. Test plan

- R1: done (#268) — a driver whose FTS5 statement fails is refused before the file exists; the built
  package on Node 22.15.0 in CI.
- R3: the dylib has minimum macOS 13.0 for both architectures (`vtool`) — the only check of macOS 13 we
  can run without a Mac on 13; each `.so` exports every `sqlite3_*` symbol Node's own build does.
- R4: on each macOS runner, under Bun, `select sqlite_version()` equals our library's; the S1 table and
  `integrity-check` work; `pnpm smoke:bun` passes. With the library removed, the system's is used.
- R5: unit tests with the maps, the check and `spawnSync` injected — no restart when the check passes,
  when SQLite is built in, or when already restarted; the exit code and signal are passed on. The
  Ubuntu CI job of item 4 runs it for real.

## 6. Open questions

None; the owner's step is the first publish of `@leemour/cli-messaging-sqlite` (item 2).
