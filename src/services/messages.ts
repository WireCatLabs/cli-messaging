import { CliError } from "@leemour/cli-core"
import type { Messenger } from "../cli/messenger/context.js"
import { type After, capability, type Sent } from "../cli/messenger/port.js"
import { parseMarkdown } from "../domain/markdown.js"
import type { Deletion, Id, Message, Page, WindowedMessage } from "../domain/models.js"
import { pickChat } from "../resolve.js"
import { codeOf, guardedWrite, type Operated } from "../sends/guarded.js"
import { newOperationId, newSendId } from "../sends/send-id.js"
import type { Upload } from "../sends/upload.js"
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

export interface SendRequest {
  chat: string
  /** As typed: with `markdown`, the marks are taken out before it is sent or measured. */
  text: string
  sendId?: string
  replyTo?: string
  silent?: boolean
  noPreview?: boolean
  markdown?: boolean
  /** ISO time to send it at; refused together with `sendId`. */
  at?: string
  attachments?: Upload[]
}

/** One message in a chat, as typed. */
export interface MessageTarget {
  chat: string
  message: string
}

export interface Pinned {
  chatId: Id
  messageId: Id
  pinned: boolean
}

export interface Reacted {
  chatId: Id
  messageId: Id
  /** `null` once it is taken off. */
  reaction: string | null
}

/** max-cli's: many at once is what a ban for automation looks like. */
export const DELETE_AT_ONCE = 10

/** Every write goes through the guard: asked before it goes, told after, on every outcome. */
export interface MessagesService {
  list(chat: string, window: ListWindow): Promise<Page<Message>>
  around(chat: string, message: string, window: AroundWindow): Promise<WindowedMessage[]>
  /** From the local store only; never asks the messenger. */
  search(query: SearchQuery): Promise<Page<StoredHit>>
  /** A reply is a send with `replyTo`. */
  send(request: SendRequest): Promise<Operated<Sent>>
  edit(target: MessageTarget & { text: string }): Promise<Operated<{ message: Message }>>
  /** Each message counts toward the hourly limit. */
  delete(request: { chat: string; messages: string[]; forEveryone: boolean }): Promise<Operated<Deletion>>
  /** Guarded against the chat it goes to: that is where somebody new reads it. */
  forward(target: MessageTarget & { to: string; silent: boolean }): Promise<Operated<{ message: Message }>>
  /** Counts toward the hourly limit only when it notifies. */
  pin(target: MessageTarget & { notify: boolean }): Promise<Operated<Pinned>>
  unpin(target: MessageTarget): Promise<Operated<Pinned>>
  /** `null` takes the reaction off. A reaction never counts toward the hourly limit. */
  react(target: MessageTarget & { emoji: string | null }): Promise<Operated<Reacted>>
}

export const messagesService = (deps: ServiceDeps): MessagesService => {
  const { guard } = deps
  const inStore = async <T>(read: (store: MessageStore, account: AccountKey) => Promise<T>): Promise<T> =>
    read(await deps.store(), await deps.account())

  const pinning = async (
    { chat, message }: MessageTarget,
    pinned: boolean,
    notify: boolean,
  ): Promise<Operated<Pinned>> => {
    const connection = await deps.connection()
    const act = pinned
      ? capability(connection, "pin", "pin a message")
      : capability(connection, "unpin", "unpin a message")
    const { id: chatId } = await connection.resolve(chat)
    const operationId = newOperationId()
    await guardedWrite(guard, { operationId, chatId, kind: "pin", messageId: message, notify }, () =>
      act(chatId, message, { notify }),
    )
    return { operationId, chatId, messageId: message, pinned }
  }

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

    send: async ({ chat, text: typed, sendId, replyTo, silent, noPreview, markdown, at, attachments = [] }) => {
      const connection = await deps.connection()
      if (at !== undefined && sendId !== undefined) {
        throw new CliError(
          "validation_error",
          "a scheduled send is never repeated: it would be scheduled twice — look in `messages scheduled` instead",
        )
      }
      const { text, markup } = markdown ? parseMarkdown(typed) : { text: typed, markup: [] }
      if (text.trim() === "" && attachments.length === 0) {
        throw new CliError("validation_error", "nothing to send — the marks leave no text")
      }
      const { id: chatId } = await connection.resolve(chat)
      const id = sendId ?? connection.newSendId?.() ?? newSendId()
      const attempt = {
        chatId,
        kind: "message" as const,
        sendId: id,
        operationId: id,
        length: text.length,
        ...(replyTo === undefined ? {} : { replyTo }),
        ...(at === undefined ? {} : { scheduledFor: at }),
        ...(attachments.length === 0
          ? {}
          : { attachments: attachments.map(({ kind, bytes }) => ({ kind, bytes: bytes.byteLength })) }),
      }
      try {
        const done = await guardedWrite(
          guard,
          attempt,
          () =>
            connection.send(chatId, text, {
              sendId: id,
              ...(replyTo === undefined ? {} : { replyTo }),
              ...(silent ? { silent } : {}),
              ...(noPreview ? { noPreview } : {}),
              ...(markup.length > 0 ? { markup } : {}),
              ...(at === undefined ? {} : { at }),
              ...(attachments.length === 0 ? {} : { attachments }),
            }),
          (sent) => ({ messageId: sent.message.id }),
        )
        return { ...done, operationId: id }
      } catch (error) {
        if (at !== undefined && codeOf(error) === "outcome_unknown") {
          throw new CliError(
            "outcome_unknown",
            "no answer — the message may have been scheduled. Look in `messages scheduled` before anything else; " +
              "never send it again with --send-id",
            { scheduledFor: at },
          )
        }
        throw error
      }
    },

    edit: async ({ chat, message, text }) => {
      const connection = await deps.connection()
      const edit = capability(connection, "edit", "edit a message")
      const { id: chatId } = await connection.resolve(chat)
      const operationId = newOperationId()
      const edited = await guardedWrite(
        guard,
        { operationId, chatId, kind: "edit", messageId: message, length: text.length },
        () => edit(chatId, message, text),
      )
      return { operationId, message: edited }
    },

    delete: async ({ chat, messages, forEveryone }) => {
      const connection = await deps.connection()
      if (messages.length > DELETE_AT_ONCE) {
        throw new CliError("validation_error", `at most ${DELETE_AT_ONCE} messages at once, got ${messages.length}`)
      }
      const remove = capability(connection, "delete", "delete messages")
      const { id: chatId } = await connection.resolve(chat)
      const operationId = newOperationId()
      await guardedWrite(guard, { operationId, chatId, kind: "delete", count: messages.length, forEveryone }, () =>
        remove(chatId, messages, { forEveryone }),
      )
      return { operationId, chatId, deleted: messages, forEveryone }
    },

    forward: async ({ chat, message, to, silent }) => {
      const connection = await deps.connection()
      const forward = capability(connection, "forward", "forward a message")
      const { id: fromChatId } = await connection.resolve(chat)
      const { id: toChatId } = await connection.resolve(to)
      const operationId = newOperationId()
      const forwarded = await guardedWrite(
        guard,
        { operationId, chatId: toChatId, kind: "forward" },
        () => forward(fromChatId, message, toChatId, silent ? { silent } : {}),
        (done) => ({ messageId: done.id }),
      )
      return { operationId, message: forwarded }
    },

    pin: ({ notify, ...target }) => pinning(target, true, notify),
    unpin: (target) => pinning(target, false, false),

    react: async ({ chat, message, emoji }) => {
      const connection = await deps.connection()
      if (emoji === "") throw new CliError("validation_error", "which emoji? give one, for example 👍")
      const react = capability(connection, "react", "react to a message")
      const { id: chatId } = await connection.resolve(chat)
      const operationId = newOperationId()
      await guardedWrite(guard, { operationId, chatId, kind: "reaction", messageId: message }, () =>
        react(chatId, message, emoji),
      )
      return { operationId, chatId, messageId: message, reaction: emoji }
    },
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
