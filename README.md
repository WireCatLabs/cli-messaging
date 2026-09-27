# @leemour/cli-messaging

The messenger-neutral half of a messaging command line tool, shared by
[`tg-cli`](https://github.com/leemour/tg-cli) and, later, [`max-cli`](https://github.com/leemour/max-cli).
Built on [`@leemour/cli-core`](https://github.com/leemour/cli-core).

**Status: 0.2.0.** The domain model, message locators, message rendering, name
resolution, the SQLite seam that runs under Node and Bun, and the first part of the command
skeleton and the send guard. Run records and the store follow — see
[the platform proposal](docs/plans/2026-09-26-platform-proposal.md).

## The rule this package keeps

**Nothing here knows a messenger.** An adapter translates its provider's objects into these types,
and a lint rule refuses any import of a messenger library or an adapter under `src/`. What only one
provider has travels in `providerMetadata`.

| | |
|---|---|
| `.` | `Chat`, `Message`, `Contact`, `Page`… · `formatLocator` / `parseLocator` · `renderMessages` · `pickChat` / `pickPerson` |
| `./store` | `openCache` — `node:sqlite` under Node, `bun:sqlite` under Bun, WAL and a busy timeout on both |
| `./sends` | the send guard: read-only profiles, an allow-list of actions, a recipient list, an hourly limit, and a journal of every attempt that never holds the text; `newSendId` for a send's identity across retries |
| `./cli` | the command skeleton: `run` (never throws, returns an exit code), the global flags, `settingsFor` (flag → environment → file → default, one strict file schema with each CLI's own fields), the profile as the first word, `--timeout` that closes what a command holds, paging |

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
written to a file. After the first publish, add a trusted publisher on npmjs.com (`leemour` /
`cli-messaging` / `release.yml`) so the second form needs no token at all.

## Licence

MIT.
