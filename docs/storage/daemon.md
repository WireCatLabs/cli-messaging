# Do we need a daemon, and what kind?

Asked by the owner on 2026-09-30, after ruling "no daemon in phases 1–2": «do we really need a daemon
later? what are tradeoffs of each approach». Three shapes are possible. The facts about today's
processes are in [`current-state.md`](current-state.md).

**Ruled 2026-09-30:** no owner daemon; background workers later. `max serve` already exists as a
daemon for MAX API requests — it keeps that job and writes pushed messages through the store like
any other process; it is not the database's owner.

## The three shapes

1. **No daemon.** Every command, MCP server and bot run opens the SQLite file itself. WAL lets
   readers work while one writer writes; `busy_timeout` makes a second writer wait instead of
   failing. This is how both CLIs work today.
2. **An owner daemon** (requirements §2, §29.10). One process per machine alone opens the database;
   every command asks it over a socket.
3. **A worker daemon.** Commands still open the database themselves; a background process runs only
   the long jobs — sync, index maintenance, enrichment — and writes through the same store.
   `max serve` is already half of this: it holds the MAX connection and writes pushed messages.

## Trade-offs

| | No daemon | Owner daemon | Worker daemon |
|---|---|---|---|
| Latency of a command | open ~1 ms (measured 0.6 ms at 1M) + query | socket round trip + query; start-up of the daemon when it is not running (~0.2 s for a Node process) | as no daemon |
| Safety with several processes | SQLite's locking, proven today by two CLIs on one file | one writer by construction | SQLite's locking; the worker must write in small transactions so a command never waits past `busy_timeout` |
| Two CLIs at different versions on one file | the newer one migrates under `BEGIN IMMEDIATE`; the older one refuses a schema below its `min_compatible` — exists today | the daemon's version decides; a CLI newer than the daemon must restart it — version hand-over across two packages released separately | as no daemon |
| Long background work (sync, enrichment, AI cost control) | nowhere to run it — a command would have to stay open | natural home | natural home |
| New code | none | a data protocol for every store call (~35 max-cli sites plus all of cli-messaging), auto-start, idle stop, lock, version hand-over, a path for `--offline`, completion, doctor, bot commands, tests | a job runner and its start/stop; no data protocol |
| When it breaks | a command fails alone | every command fails until the daemon is back; a stuck daemon blocks everything | background work stops; commands keep working |
| Memory | only while a command runs | resident (~150 MB for SQLite at 1M, measured) | resident while jobs run |
| Windows | nothing extra | named pipes instead of Unix sockets | same, only for its control channel |
| Tests | open a temporary file | start a daemon per test, or mock the protocol | open a temporary file; test the worker alone |
| Needed for an engine | SQLite: no | PGlite: yes (no lock of its own) — ruled out | — |
| A Postgres backend later | Postgres is its own server — no daemon needed | adds nothing Postgres does not do | as no daemon |

## Recommendation

**No owner daemon, now or later**, unless one of these becomes true:

- measured lock contention: commands waiting on a writer long enough to matter (`busy_timeout` hits);
- an engine without multi-process safety is chosen again;
- the store has to be shared with another machine without a database server.

**A worker daemon when phase 3–4 arrives** (graph building, AI enrichment), because those runs are
long, need a budget and a queue, and must survive the command that started them. Start from `max
serve`'s lifecycle (auto-start, idle stop, version hand-over, `src/server/start.ts` in max-cli)
rather than a new one, and make it messenger-neutral in cli-messaging so tg-cli gets it too.
