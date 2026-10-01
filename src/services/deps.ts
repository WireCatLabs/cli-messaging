import { CliError } from "@leemour/cli-core"
import type { Messenger } from "../cli/messenger/context.js"
import type { MessengerAdapter } from "../cli/messenger/port.js"
import type { SendGuard } from "../sends/guard.js"
import type { AccountKey, MessageStore } from "../store/store.js"

/**
 * What a service works with. Each part is opened on first use, so a read from the store never
 * connects and a command that never touches the store never opens it. Whoever built the deps closes
 * what they opened.
 */
export interface ServiceDeps {
  messenger: Messenger
  offline: boolean
  account: () => Promise<AccountKey>
  /** Already saving what its reads answer, and recording each call as a run event. */
  connection: () => Promise<MessengerAdapter>
  store: () => Promise<MessageStore>
  guard: SendGuard
}

/** Online, the store only adds to an answer the messenger already gave, so a store that will not open loses nothing. */
export const storeIfOpen = async (deps: ServiceDeps): Promise<MessageStore | undefined> => {
  try {
    return await deps.store()
  } catch {
    return undefined
  }
}

export const OFFLINE =
  "--offline answers only from what is kept locally: `chats list|show`, `messages list|show|context` and `contacts list|show`"

/** Over a connection that is already open — an MCP session holds one for minutes. */
export const onlineDeps = (messenger: Messenger, adapter: MessengerAdapter, guard: SendGuard): ServiceDeps => ({
  messenger,
  offline: false,
  guard,
  connection: async () => adapter,
  account: async () => {
    const self = adapter.self()
    if (self === null) throw new CliError("authentication_error", "the connection does not know whose account it is")
    return { provider: messenger.provider, account: self }
  },
  store: async () => {
    throw new CliError("validation_error", "this answer comes from the messenger, not from the local store")
  },
})

/** Over the local store alone, for `--offline` and the tools that never ask the messenger. */
export const storedDeps = (
  messenger: Messenger,
  store: MessageStore,
  account: AccountKey,
  guard: SendGuard,
): ServiceDeps => ({
  messenger,
  offline: true,
  guard,
  account: async () => account,
  store: async () => store,
  connection: async () => {
    throw new CliError("validation_error", OFFLINE)
  },
})
