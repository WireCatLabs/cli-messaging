import { isCliFailure } from "../failures.js"
import { type EventSink, providerErrorKey } from "../runs/events.js"
import type { MessengerAdapter } from "./port.js"

type Named = { ids?: Record<string, string>; counts?: Record<string, number> }

/**
 * The adapter, with a request and a response event around each call. **Ids come from arguments
 * that already are ids, or from the answer — never from a typed chat**, which is often a title.
 */
export const observed = (messenger: MessengerAdapter, events: EventSink): MessengerAdapter => {
  const timed = async <T>(operation: string, named: Named, work: () => Promise<T>, after?: (answer: T) => Named) => {
    events({ event: "request", operation, ...named })
    const started = performance.now()
    const durationMs = () => Math.round(performance.now() - started)
    try {
      const answer = await work()
      events({ event: "response", operation, durationMs: durationMs(), outcome: "ok", ...after?.(answer) })
      return answer
    } catch (error) {
      const providerError = isCliFailure(error) ? providerErrorKey(error.details?.providerError) : undefined
      events({
        event: "response",
        operation,
        durationMs: durationMs(),
        outcome: "error",
        errorCode: isCliFailure(error) ? error.code : "generic_failure",
        ...(providerError ? { providerError } : {}),
      })
      throw error
    }
  }

  return {
    self: () => messenger.self(),
    me: () => timed("account.me", {}, () => messenger.me()),
    chats: (window) =>
      timed(
        "chats.list",
        {},
        () => messenger.chats(window),
        (page) => ({ counts: { chats: page.items.length } }),
      ),
    history: (reference, options) =>
      timed(
        "messages.list",
        {},
        () => messenger.history(reference, options),
        (page) => ({
          ...(page.items[0] ? { ids: { chat: page.items[0].chatId } } : {}),
          counts: { messages: page.items.length },
        }),
      ),
    resolve: (reference) =>
      timed(
        "chats.resolve",
        {},
        () => messenger.resolve(reference),
        (chat) => ({ ids: { chat: chat.id } }),
      ),
    chat: (reference) =>
      timed(
        "chats.show",
        {},
        () => messenger.chat(reference),
        (card) => ({ ids: { chat: card.id }, ...(card.members ? { counts: { members: card.members.length } } : {}) }),
      ),
    contact: (reference) =>
      timed(
        "contacts.show",
        {},
        () => messenger.contact(reference),
        (card) => ({ ids: { person: card.id }, counts: { chats: card.chats.length } }),
      ),
    around: (reference, messageId, window) =>
      timed(
        "messages.around",
        { ids: { message: messageId } },
        () => messenger.around(reference, messageId, window),
        (items) => ({
          ...(items[0] ? { ids: { chat: items[0].chatId, message: messageId } } : {}),
          counts: { messages: items.length },
        }),
      ),
    send: (chatId, text, options) =>
      timed(
        "messages.send",
        { ids: { chat: chatId, send: options.sendId } },
        () => messenger.send(chatId, text, options),
        (sent) => ({ ids: { message: sent.message.id } }),
      ),
    logout: () => timed("session.logout", {}, () => messenger.logout()),
    close: () => messenger.close(),
  }
}
