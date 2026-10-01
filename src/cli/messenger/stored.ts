import type { MessageEvent } from "../../domain/models.js"
import type { AccountKey, MessageStore } from "../../store/store.js"
import type { EventSink } from "../runs/events.js"
import { capability, type MessengerAdapter, throughWrapper } from "./port.js"

export interface Saving {
  account: AccountKey
  /** Opened on the first save, not before: a command that reads nothing has no reason to touch the file. */
  store: () => Promise<MessageStore | undefined>
  warn: (message: string) => void
  events: EventSink
  /** Saves still writing, for the closer to wait on: `watch` does not hold the next event for one. */
  pending?: Set<Promise<void>>
}

/**
 * The adapter, with what each read answers written to the store. **A failed write never fails the
 * read** — the answer is already here, and it is what was asked for.
 *
 * `resolve` is not saved: a chat found by name has no unread count or last message, and writing it
 * would erase what `chats list` stored. Nor are `chat` and `contact`: a card's member list is not
 * known to be whole, and `saveMembers` replaces the list.
 */
export const stored = (
  messenger: MessengerAdapter,
  { account, store, warn, events, pending }: Saving,
): MessengerAdapter => {
  let warned = false
  const attempt = async (operation: string, write: (store: MessageStore) => Promise<unknown>): Promise<void> => {
    try {
      const opened = await store()
      if (opened) await write(opened)
    } catch (error) {
      events({ event: "warning", code: "store_not_written", operation })
      if (!warned) warn(`not saved to the local store: ${error instanceof Error ? error.message : String(error)}`)
      warned = true
    }
  }
  const save = (operation: string, writing: (store: MessageStore) => Promise<unknown>): Promise<void> => {
    const saving = attempt(operation, writing)
    pending?.add(saving)
    return saving.finally(() => pending?.delete(saving))
  }

  // A method not listed here saves nothing and passes through; a lane that should save adds its line.
  return throughWrapper(messenger, {
    self: () => messenger.self(),
    resolve: (reference) => messenger.resolve(reference),
    chat: (reference) => messenger.chat(reference),
    contact: (reference) => messenger.contact(reference),
    logout: () => messenger.logout(),
    close: () => messenger.close(),
    me: async () => {
      const me = await messenger.me()
      await save("account.me", (opened) => opened.saveAccount(account, { name: me.name }))
      return me
    },
    chats: async (window) => {
      const page = await messenger.chats(window)
      // Only a page that names every chat says the others were left; an empty one is a hiccup.
      const complete = window.offset === 0 && !page.hasMore && page.items.length > 0
      await save("chats.list", async (opened) => {
        await opened.saveChats(account, page.items)
        if (complete)
          await opened.markChatsLeft(
            account,
            page.items.map((chat) => chat.id),
          )
      })
      return page
    },
    history: async (reference, options) => {
      const seenAt = Date.now()
      const page = await messenger.history(reference, options)
      const chatId = page.items[0]?.chatId
      if (chatId !== undefined) {
        await save("messages.list", (opened) =>
          opened.saveMessages(account, chatId, page.items, { via: "history", seenAt }),
        )
      }
      return page
    },
    around: async (reference, messageId, window) => {
      const seenAt = Date.now()
      const items = await messenger.around(reference, messageId, window)
      const chatId = items[0]?.chatId
      if (chatId !== undefined) {
        const plain = items.map(({ anchor, ...message }) => message)
        await save("messages.around", (opened) =>
          opened.saveMessages(account, chatId, plain, { via: "context", seenAt }),
        )
      }
      return items
    },
    ...(messenger.watch
      ? {
          watch: (onEvent, signal, onReady) =>
            messenger.watch?.(
              (event) => {
                const seenAt = Date.now()
                void save("messages.watch", (opened) => keep(opened, account, event, seenAt))
                onEvent(event)
              },
              signal,
              onReady,
            ) ?? Promise.resolve(),
        }
      : {}),
    ...(messenger.edit
      ? {
          edit: async (chatId, messageId, text, options) => {
            const seenAt = Date.now()
            const edited = await capability(messenger, "edit", "edit")(chatId, messageId, text, options)
            await save("messages.edit", (opened) =>
              opened.saveMessages(account, chatId, [edited], { via: "update", seenAt }),
            )
            return edited
          },
        }
      : {}),
    ...(messenger.forward
      ? {
          forward: async (fromChatId, messageId, toChatId, options) => {
            const copy = await capability(messenger, "forward", "forward")(fromChatId, messageId, toChatId, options)
            await save("messages.forward", (opened) => opened.saveMessages(account, toChatId, [copy], { via: "send" }))
            return copy
          },
        }
      : {}),
    // Without this, a message deleted here would still be found by `messages search` and read `--offline`.
    ...(messenger.delete
      ? {
          delete: async (chatId, messageIds, options) => {
            await capability(messenger, "delete", "delete")(chatId, messageIds, options)
            await save("messages.delete", (opened) => opened.markDeleted(account, messageIds, { chatId }))
          },
        }
      : {}),
    send: async (chatId, text, options) => {
      const sent = await messenger.send(chatId, text, options)
      // A scheduled message is not in the chat yet, and it will arrive under another id.
      if (options.at === undefined) {
        await save("messages.send", (opened) => opened.saveMessages(account, chatId, [sent.message], { via: "send" }))
      }
      return sent
    },
  })
}

/** Each change as the store keeps it: a message or an edit upserted, a deletion a tombstone, reactions replaced. */
const keep = async (store: MessageStore, account: AccountKey, event: MessageEvent, seenAt: number): Promise<void> => {
  switch (event.event) {
    case "message":
    case "edit": {
      const { chatTitle, ...message } = event.message
      await store.saveMessages(account, message.chatId, [message], { via: "update", seenAt })
      return
    }
    case "delete":
      await store.markDeleted(account, [event.messageId], event.chatId === null ? {} : { chatId: event.chatId })
      return
    case "reaction":
      await store.saveReactions(account, event.chatId, event.messageId, event.reactions)
  }
}
