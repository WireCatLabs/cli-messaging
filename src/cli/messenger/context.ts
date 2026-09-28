import { CliError } from "@leemour/cli-core"
import type { Command } from "commander"
import type { Chat, Id, Provider } from "../../domain/models.js"
import { guardFor, type SendGuard } from "../../sends/guard.js"
import { type AccountKey, type MessageStore, openStore } from "../../store/store.js"
import type { AppIdentity } from "../app.js"
import { type BaseContext, baseContext, environmentOf } from "../context.js"
import type { EventSink } from "../runs/events.js"
import type { GlobalFlags, ResolveOptions, Settings } from "../settings.js"
import { recalledAccount, rememberAccount } from "./accounts.js"
import { observed } from "./observed.js"
import type { MessengerAdapter } from "./port.js"
import { stored } from "./stored.js"

/** `listen` opens a connection that receives updates — only `watch` asks; the rest stay quiet. */
export interface ConnectOptions {
  listen?: boolean
  /** Fetch what arrived while nothing listened — `serve` only; `watch` starts from now. */
  catchUp?: boolean
}

/** What one messenger CLI hands the shared commands. Everything else about it stays in its own code. */
export interface Messenger {
  app: AppIdentity
  provider: Provider
  /** The messenger's own name, as its users write it — `Telegram`, `MAX`. Defaults to the command. */
  name?: string
  resolveSettings: (flags: GlobalFlags, options?: ResolveOptions) => Settings
  /**
   * Opens a connection for the command's profile, or throws a typed error saying how to log in.
   * Called inside `--timeout`; the context tracks and closes what it returns.
   */
  connect: (command: Command, context: BaseContext, options?: ConnectOptions) => Promise<MessengerAdapter>
  /** The help for a `<chat>` argument, in this messenger's words. */
  chatArgument: string
  /** The chat `me` names, when the messenger has a notes-to-self chat. */
  savedChatId?: (account: AccountKey) => Id
  /** The other person in a one-to-one chat, when the chat says who — a recipient list matches on it. */
  partnerOf?: (chat: Chat) => Id | undefined
  /** What only this messenger can say about itself for `doctor`, read from disk — never a secret. */
  diagnose?: (command: Command, context: BaseContext) => Promise<Record<string, unknown>>
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
  withMessenger: <T>(work: (messenger: MessengerAdapter) => Promise<T>, options?: ConnectOptions) => Promise<T>
  /** Answers from the message store alone, for `--offline`. Never connects and needs no credentials. */
  withStore: <T>(work: (store: MessageStore, account: AccountKey) => T, options?: { name?: string }) => Promise<T>
}

/**
 * A connection as every shared reader sees it: its account remembered, each call a run event, what
 * the reads answer saved to the store. `close` closes the connection and the store it opened. One
 * function, so a command and an MCP tool call save and record exactly alike.
 */
export const connected = (
  connection: MessengerAdapter,
  { app, provider }: Pick<Messenger, "app" | "provider">,
  { settings, env, renderer }: Pick<BaseContext, "settings" | "env" | "renderer">,
  events: EventSink,
): { adapter: MessengerAdapter; close: () => Promise<void> } => {
  const self = connection.self()
  if (self !== null) rememberAccount(app, settings.profile, self, env)
  const adapter = observed(connection, events)
  let store: Promise<MessageStore | undefined> | undefined
  return {
    adapter:
      self === null
        ? adapter
        : stored(adapter, {
            account: { provider, account: self },
            store: () => {
              store ??= openStore({ env })
              return store
            },
            warn: renderer.warn,
            events,
          }),
    close: async () => {
      await connection.close()
      if (store) (await store.catch(() => undefined))?.close()
    },
  }
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
    withMessenger: (work, options = {}) =>
      base.run(
        async (events) => {
          if (base.settings.offline) {
            throw new CliError(
              "validation_error",
              "--offline answers only from what is kept locally: `chats list`, `messages list|show|context` and `contacts list`",
            )
          }
          const connection = await messenger.connect(command, base, options)
          base.track(connection)
          const { adapter, close } = connected(connection, messenger, base, events)
          try {
            return await work(adapter)
          } finally {
            await close()
          }
        },
        { unbounded: options.listen === true },
      ),
    withStore: (work, { name } = {}) =>
      base.run(
        async () => {
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
        },
        name === undefined ? {} : { name },
      ),
  }
}
