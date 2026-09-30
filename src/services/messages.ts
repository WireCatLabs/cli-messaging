import { CliError } from "@leemour/cli-core"
import type { Messenger } from "../cli/messenger/context.js"
import { type After, capability } from "../cli/messenger/port.js"
import type { Message, Page, WindowedMessage } from "../domain/models.js"
import { pickChat } from "../resolve.js"
import type { AccountKey, MessageStore, StoredHit } from "../store/store.js"
import type { ServiceDeps } from "./deps.js"

export interface ListWindow {
  limit: number
  before?: string
  /** Read forward from this message or moment, parsed by the caller in its own words (`afterOf`). */
  after?: After
}

export interface AroundWindow {
  before: number
  after: number
}

export interface SearchQuery {
  text?: string
  pattern?: RegExp
  chat?: string
  limit: number
}

export interface MessagesService {
  list(chat: string, window: ListWindow): Promise<Page<Message>>
  around(chat: string, message: string, window: AroundWindow): Promise<WindowedMessage[]>
  /** From the local store only; never asks the messenger. */
  search(query: SearchQuery): Promise<Page<StoredHit>>
}

export const messagesService = (deps: ServiceDeps): MessagesService => {
  const inStore = async <T>(read: (store: MessageStore, account: AccountKey) => Promise<T>): Promise<T> =>
    read(await deps.store(), await deps.account())

  return {
    list: async (chat, { limit, before, after }) => {
      if (after !== undefined) {
        if (deps.offline)
          throw new CliError("validation_error", "--after reads from the messenger; the store pages only backwards")
        const connection = await deps.connection()
        return capability(connection, "historyAfter", "read forward from a message")(chat, { limit, after })
      }
      const window = { limit, ...(before === undefined ? {} : { before }) }
      if (deps.offline) {
        return inStore(async (store, account) =>
          store.messages(account, await storedChatId(deps.messenger, chat, store, account), window),
        )
      }
      return (await deps.connection()).history(chat, window)
    },

    around: async (chat, message, window) => {
      if (deps.offline) {
        return inStore(async (store, account) =>
          store.around(account, await storedChatId(deps.messenger, chat, store, account), message, window),
        )
      }
      return (await deps.connection()).around(chat, message, window)
    },

    search: ({ text, pattern, chat, limit }) =>
      inStore(async (store, account) =>
        store.find({
          ...(pattern ? { pattern } : { text: text ?? "" }),
          account,
          limit,
          ...(chat === undefined ? {} : { chatId: await storedChatId(deps.messenger, chat, store, account) }),
        }),
      ),
  }
}

/** A chat as typed, found among the stored chats the way an adapter finds it among its own. */
export const storedChatId = async (
  messenger: Messenger,
  reference: string,
  store: MessageStore,
  account: AccountKey,
): Promise<string> => {
  const trimmed = reference.trim()
  if (messenger.savedChatId && ["me", "self", "saved"].includes(trimmed.toLowerCase())) {
    return messenger.savedChatId(account)
  }
  if (/^-?\d+$/.test(trimmed)) return trimmed
  const chats = (await store.chats(account, {})).items
  if (trimmed.startsWith("@")) {
    const username = trimmed.slice(1).toLowerCase()
    const found = chats.find((one) => String(one.providerMetadata?.username ?? "").toLowerCase() === username)
    if (!found) throw new CliError("not_found", `no stored chat is ${trimmed}`)
    return found.id
  }
  return pickChat(trimmed, chats).id
}
