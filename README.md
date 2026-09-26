# @leemour/cli-messaging

The messenger-neutral half of a messaging command line tool, shared by
[`tg-cli`](https://github.com/leemour/tg-cli) and, later, [`max-cli`](https://github.com/leemour/max-cli).
Built on [`@leemour/cli-core`](https://github.com/leemour/cli-core).

**Status: 0.1.0, not published.** The first slice: the domain model, message locators, message
rendering, name resolution, and the SQLite seam that runs under Node and Bun. The store, the send
guard and the command skeleton follow — see
[the platform proposal](docs/plans/2026-09-26-platform-proposal.md).

## The rule this package keeps

**Nothing here knows a messenger.** An adapter translates its provider's objects into these types,
and a lint rule refuses any import of a messenger library or an adapter under `src/`. What only one
provider has travels in `providerMetadata`.

| | |
|---|---|
| `.` | `Chat`, `Message`, `Contact`, `Page`… · `formatLocator` / `parseLocator` · `renderMessages` · `pickChat` / `pickPerson` |
| `./store` | `openCache` — `node:sqlite` under Node, `bun:sqlite` under Bun, WAL and a busy timeout on both |

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

## Licence

MIT.
