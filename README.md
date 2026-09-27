# @leemour/cli-messaging

The messenger-neutral half of a messaging command line tool, shared by
[`tg-cli`](https://github.com/leemour/tg-cli) and, later, [`max-cli`](https://github.com/leemour/max-cli).
Built on [`@leemour/cli-core`](https://github.com/leemour/cli-core).

**Status: 0.19.0.** The domain model, message locators, message rendering, name
resolution, the SQLite seam that runs under Node and Bun, and the first part of the command
skeleton with the shared read commands, the send guard, run records and the message store — see
[the platform proposal](docs/plans/2026-09-26-platform-proposal.md).

## The rule this package keeps

**Nothing here knows a messenger.** An adapter translates its provider's objects into these types,
and a lint rule refuses any import of a messenger library or an adapter under `src/`. What only one
provider has travels in `providerMetadata`.

| | |
|---|---|
| `.` | `Chat`, `Message`, `Contact`, `Page`… · `formatLocator` / `parseLocator` · `renderMessages` · `pickChat` / `pickPerson` |
| `./store` | `openCache` — `node:sqlite` under Node, `bun:sqlite` under Bun, WAL and a busy timeout on both · `openStore` — the shared message store: one file for every messenger (`MESSAGING_STORE` overrides where), forward-only migrations with `min_compatible`, every sender an identity with a person of their own, edits kept as revisions, a message by its id, deletions kept as tombstones, trigram search · `find` — by text, by sender, or both; `together` for the chats where every sender wrote, `perChat` to cap each chat · `savePeople` and `people` — usernames and bot flags, and a `PeopleLookup` for `pickPerson` |
| `./sends` | the send guard: read-only profiles, an allow-list of actions, a recipient list, an hourly limit, and a journal of every attempt that never holds the text; `newSendId` for a send's identity across retries |
| `./cli` | the command skeleton: `run` (never throws, returns an exit code), the global flags, `settingsFor` (flag → environment → file → default, one strict file schema with each CLI's own fields), the profile as the first word, `--timeout` that closes what a command holds, paging, and run records: `--record` keeps a run's ids and timings (never content), a failure is kept unless `--no-record`, and `runsCommand` gives `runs list\|show\|path` · `configCommand(app, config)` shows and changes the settings with where each came from · `completeCommand(messenger, config)` gives shell completion, chat ids from the store and never a connection · `doctorCommand(messenger)` reports the installation's state from disk (the store, the account, sends, runs, the messenger's own checks), and connects only with `--online` · `commandsCommand(app)` describes every command as JSON, with `contract` (`CONTRACT`, the major version of the output types) and which commands write · the shared read commands: a CLI describes its messenger once (`Messenger`: its app, a `connect` that returns a `MessengerAdapter`, how `me` maps to a chat) and gets `accountCommand`, `chatsCommand` (`list`, `show`), `contactsCommand` (`list`, `show`) `recipientsCommand`, `sendsCommand`, `watchCommand` (new messages as they arrive, `--jsonl`, until Ctrl-C or `--timeout`; `--events` adds edits, deletions and reactions, each kept in the store), `backfillCommand` (a chat's history into the store, resumable, FloodWait-aware), `serveCommand` (keeps the store current until stopped — one per profile by a lock file, catch-up on, started by a person or a service unit), and `messagesCommand` (`list`, `show`, `context`, `search` over the store by word beginnings, and `send`/`reply` through the send guard; a `msg:` locator names a message) — every read saved to the store, `--offline` answered from it, each call a run event |

⚠ **Errors are recognised by shape, not by class** (`isCliFailure`). A package linked during
development brings its own copy of cli-core, and an error built by one copy is not an `instanceof`
the other's class.

A **message locator** names one message across every provider and account:
`msg:telegram/<account>/<chat>/<message>`. A message id alone does not — Telegram numbers messages
per chat in channels and per account in private chats.

## Where it came from

The files were copied from max-cli at `3ca8874`, from the part its lint rule `CLI-30` already kept
free of MAX. What changed on the way is listed as `DEBT-1`…`DEBT-10` in the proposal.

## Checks

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test
pnpm smoke:bun    # the same exports, run under Bun
```

## Releasing

Raise `version` in `package.json` through a pull request, merge it, then on `main`:

```sh
bin/release --local   # from this machine: NPM_TOKEN if exported, else the keyring (service npm, account leemour)
bin/release           # from GitHub Actions, once npm trusts .github/workflows/release.yml
```

Both refuse a dirty tree, a branch other than `main`, an unpushed `main` and a version npm already
has, run every check, and tag `v<version>` once npm shows it. The token is never printed and never
written to a file. The GitHub form publishes from the job in the `npm` environment, which is what
npm's trusted publisher names: `leemour` / `cli-messaging` / `release.yml` / environment `npm`.

## Licence

MIT.
