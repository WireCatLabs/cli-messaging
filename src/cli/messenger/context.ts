import { CliError } from "@leemour/cli-core"
import type { Command } from "commander"
import type { Id, Provider } from "../../domain/models.js"
import { guardFor, type SendGuard } from "../../sends/guard.js"
import { type AccountKey, type MessageStore, openStore } from "../../store/store.js"
import type { AppIdentity } from "../app.js"
import { type BaseContext, baseContext, environmentOf } from "../context.js"
import type { GlobalFlags, ResolveOptions, Settings } from "../settings.js"
import { recalledAccount, rememberAccount } from "./accounts.js"
import { observed } from "./observed.js"
import type { MessengerAdapter } from "./port.js"
import { stored } from "./stored.js"

/** What one messenger CLI hands the shared commands. Everything else about it stays in its own code. */
export interface Messenger {
  app: AppIdentity
  provider: Provider
  resolveSettings: (flags: GlobalFlags, options?: ResolveOptions) => Settings
  /**
   * Opens a connection for the command's profile, or throws a typed error saying how to log in.
   * Called inside `--timeout`; the context tracks and closes what it returns.
   */
  connect: (command: Command, context: BaseContext) => Promise<MessengerAdapter>
  /** The help for a `<chat>` argument, in this messenger's words. */
  chatArgument: string
  /** The chat `me` names, when the messenger has a notes-to-self chat. */
  savedChatId?: (account: AccountKey) => Id
}

export interface MessengerContext extends BaseContext {
  profile: string
  stdin: NodeJS.ReadableStream & { isTTY?: boolean }
  /** Read-only, the allow-list, the recipient list and the hourly limit — asked before every write, told after. */
  guard: SendGuard
  /**
   * Connects inside `--timeout`, and closes on every path. What the reads answer is saved to the
   * message store, and each call is a run event.
   */
  withMessenger: <T>(work: (messenger: MessengerAdapter) => Promise<T>) => Promise<T>
  /** Answers from the message store alone, for `--offline`. Never connects and needs no credentials. */
  withStore: <T>(work: (store: MessageStore, account: AccountKey) => T) => Promise<T>
}

export const messengerContext = (command: Command, messenger: Messenger): MessengerContext => {
  const { app, provider } = messenger
  const base = baseContext(command, messenger.resolveSettings)
  const { profile } = base.settings

  return {
    ...base,
    profile,
    stdin: environmentOf(command).stdin ?? process.stdin,
    guard: guardFor(app, base.settings, base.renderer.warn, base.env),
    withMessenger: (work) =>
      base.run(async (events) => {
        if (base.settings.offline) {
          throw new CliError(
            "validation_error",
            "--offline answers only from what is kept locally: `chats list`, `messages list|show|context` and `contacts list`",
          )
        }
        const connection = await messenger.connect(command, base)
        base.track(connection)
        let store: Promise<MessageStore | undefined> | undefined
        try {
          const self = connection.self()
          if (self !== null) rememberAccount(app, profile, self, base.env)
          const adapter = observed(connection, events)
          return await work(
            self === null
              ? adapter
              : stored(adapter, {
                  account: { provider, account: self },
                  store: () => {
                    store ??= openStore({ env: base.env })
                    return store
                  },
                  warn: base.renderer.warn,
                  events,
                }),
          )
        } finally {
          await connection.close()
          if (store) (await store.catch(() => undefined))?.close()
        }
      }),
    withStore: (work) =>
      base.run(async () => {
        const account = recalledAccount(app, provider, profile, base.env)
        if (!account) {
          throw new CliError(
            "not_found",
            `nothing recorded for profile "${profile}" yet — run the command once without --offline`,
          )
        }
        const store = await openStore({ env: base.env })
        try {
          return work(store, account)
        } finally {
          store.close()
        }
      }),
  }
}
