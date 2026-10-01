import { CliError } from "@leemour/cli-core"
import type { Messenger } from "../cli/messenger/context.js"
import { type After, capability, type Download, type Sent } from "../cli/messenger/port.js"
import { parseMarkdown } from "../domain/markdown.js"
import type { Deletion, Id, Message, Page, WindowedMessage } from "../domain/models.js"
import { pickChat, pickPerson } from "../resolve.js"
import { parseQuery } from "../search/query.js"
import { type Match, search } from "../search/search.js"
import { codeOf, guardedWrite, type Operated } from "../sends/guarded.js"
import { newOperationId, newSendId } from "../sends/send-id.js"
import type { Upload } from "../sends/upload.js"
import type { AccountKey, ChatCompleteness, MessageStore, SearchScope, StoredHit, WordQuery } from "../store/store.js"
import { fromStore, nothingStored, PUSHED, type ServiceDeps } from "./deps.js"

export interface ListWindow {
  limit: number
  before?: string
  /** Read back from this moment, epoch milliseconds. */
  beforeTime?: number
  /** Read forward from this message or moment, parsed by the caller in its own words (`afterOf`). */
  after?: After
}

export interface AroundWindow {
  before: number
  after: number
}

export interface SearchQuery {
  /** The query language of the phase 2 plan, §4: words, "phrases", -word, OR, and filters. */
  text?: string
  pattern?: RegExp
  chat?: string
  limit: number
  /** Newest first instead of best first. */
  newest?: boolean
  /** Messages before and after each hit, from the store. */
  context?: number
}

export type FoundMessage = StoredHit & { match?: Match; score?: number | null; context?: WindowedMessage[] }

export interface SearchFound extends Page<FoundMessage> {
  corrections: { from: string; to: string[] }[]
  /** Per chat of the page: how much of its history the store holds. */
  completeness: ChatCompleteness[]
  /** `false` while the word index is being built: the answer came from the substring index. */
  wordsReady: boolean
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

/** How long a search may spend building the word index first (phase 2 plan S3: about 200 ms). */
export const SEARCH_FILL_MS = 200

/** Every write goes through the guard: asked before it goes, told after, on every outcome. */
export interface MessagesService {
  list(chat: string, window: ListWindow): Promise<Page<Message>>
  around(chat: string, message: string, window: AroundWindow): Promise<WindowedMessage[]>
  /** The files of one message. Always from the messenger, whatever its history is read from. */
  download(chat: string, message: Id): Promise<Download>
  /** From the local store only; never asks the messenger. */
  search(query: SearchQuery): Promise<SearchFound>
  /** A reply is a send with `replyTo`. */
  send(request: SendRequest): Promise<Operated<Sent>>
  /** With `markdown`, the marks are taken out as a send takes them. */
  edit(target: MessageTarget & { text: string; markdown?: boolean }): Promise<Operated<{ message: Message }>>
  /** Each message counts toward the hourly limit. */
  delete(request: { chat: string; messages: string[]; forEveryone: boolean }): Promise<Operated<Deletion>>
  /** Guarded against the chat it goes to: that is where somebody new reads it. */
  forward(
    target: MessageTarget & { to: string; silent: boolean; sendId?: string },
  ): Promise<Operated<{ sendId: string; message: Message }>>
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
    list: async (chat, { limit, before, beforeTime, after }) => {
      if (beforeTime !== undefined) {
        if (deps.offline)
          throw new CliError("validation_error", "reading back from a time asks the messenger; not with --offline")
        if (fromStore(deps)) throw new CliError("validation_error", `${PUSHED}, which pages back from a message only`)
        const connection = await deps.connection()
        return capability(connection, "historyBefore", "read back from a time")(chat, { limit, time: beforeTime })
      }
      if (after !== undefined) {
        if (deps.offline)
          throw new CliError("validation_error", "reading forward asks the messenger; the store pages only backwards")
        if (fromStore(deps)) throw new CliError("validation_error", `${PUSHED}, which pages only backwards`)
        const connection = await deps.connection()
        return capability(connection, "historyAfter", "read forward from a message")(chat, { limit, after })
      }
      const window = { limit, ...(before === undefined ? {} : { before }) }
      if (fromStore(deps)) {
        return inStore(async (store, account) =>
          store.messages(account, await readChatId(deps, chat, store, account), window),
        )
      }
      return capability(await deps.connection(), "history", "read a chat's history")(chat, window)
    },

    around: async (chat, message, window) => {
      if (fromStore(deps)) {
        return inStore(async (store, account) =>
          store.around(account, await readChatId(deps, chat, store, account), message, window),
        )
      }
      return capability(await deps.connection(), "around", "read the messages around one")(chat, message, window)
    },

    download: async (chat, message) =>
      capability(await deps.connection(), "download", "download attachments")(chat, message),

    search: ({ text, pattern, chat, limit, newest = false, context = 0 }) =>
      inStore(async (store, account): Promise<SearchFound> => {
        // A large file builds its word index a slice per search as well as in `store migrate` (NEED-453 A).
        const stop = Date.now() + SEARCH_FILL_MS
        await store.fillSearchIndex({ until: () => Date.now() >= stop })
        const found = pattern
          ? {
              ...(await store.find({
                pattern,
                account,
                limit,
                ...(chat === undefined ? {} : { chatId: await storedChatId(deps.messenger, chat, store, account) }),
              })),
              corrections: [],
              wordsReady: true,
            }
          : await search(store, ...(await scopeOf(deps.messenger, store, account, text ?? "", chat)), { limit, newest })
        const chats = [...new Set(found.items.map((hit) => hit.chatId))]
        const items = await Promise.all(
          found.items.map(async (hit) =>
            context > 0
              ? {
                  ...hit,
                  context: await store.around(account, hit.chatId, hit.id, { before: context, after: context }),
                }
              : hit,
          ),
        )
        return { ...found, items, completeness: await store.chatCompleteness(account, chats) }
      }),

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

    edit: async ({ chat, message, text: typed, markdown }) => {
      const connection = await deps.connection()
      const edit = capability(connection, "edit", "edit a message")
      const { text, markup } = markdown ? parseMarkdown(typed) : { text: typed, markup: [] }
      if (text.trim() === "") throw new CliError("validation_error", "no new text — the marks leave nothing")
      const { id: chatId } = await connection.resolve(chat)
      const operationId = newOperationId()
      const edited = await guardedWrite(
        guard,
        { operationId, chatId, kind: "edit", messageId: message, length: text.length },
        () => edit(chatId, message, text, markup.length > 0 ? { markup } : {}),
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

    forward: async ({ chat, message, to, silent, sendId }) => {
      const connection = await deps.connection()
      const forward = capability(connection, "forward", "forward a message")
      const { id: fromChatId } = await connection.resolve(chat)
      const { id: toChatId } = await connection.resolve(to)
      const id = sendId ?? connection.newSendId?.() ?? newSendId()
      const forwarded = await guardedWrite(
        guard,
        { operationId: id, sendId: id, chatId: toChatId, kind: "forward" },
        () => forward(fromChatId, message, toChatId, { sendId: id, ...(silent ? { silent } : {}) }),
        (done) => ({ messageId: done.id }),
      )
      return { operationId: id, sendId: id, message: forwarded }
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

/**
 * The chat a store read is about. Offline, a chat with nothing kept answers empty, as it always has;
 * in store mode the store is the only source, so an empty answer would pass for "nothing was said".
 */
export const readChatId = async (
  deps: ServiceDeps,
  reference: string,
  store: MessageStore,
  account: AccountKey,
): Promise<string> => {
  if (deps.reads !== "store") return storedChatId(deps.messenger, reference, store, account)
  const chatId = await storedChatId(deps.messenger, reference, store, account).catch((error: unknown) => {
    if (codeOf(error) === "not_found") throw new CliError("not_found", nothingStored(deps.messenger))
    throw error
  })
  if ((await store.countMessages(account, chatId)) === 0) {
    throw new CliError("not_found", nothingStored(deps.messenger), { chat: chatId })
  }
  return chatId
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
  const exact = chats.find((one) => one.id === trimmed)
  if (exact) return exact.id
  if (trimmed.startsWith("@")) {
    const username = trimmed.slice(1).toLowerCase()
    const found = chats.find((one) => String(one.providerMetadata?.username ?? "").toLowerCase() === username)
    if (!found) throw new CliError("not_found", `no stored chat is ${trimmed}`)
    return found.id
  }
  return pickChat(trimmed, chats).id
}

/**
 * The parsed query and the scope it names, resolved in this account: `chat:` as `--chat` is, `from:`
 * through the names `contacts search` uses, `from:me` as what the account sent.
 */
const scopeOf = async (
  messenger: Messenger,
  store: MessageStore,
  account: AccountKey,
  text: string,
  chat: string | undefined,
): Promise<[WordQuery, SearchScope]> => {
  const parsed = parseQuery(text)
  if (chat !== undefined && parsed.chat !== undefined && parsed.chat !== chat) {
    throw new CliError("validation_error", `--chat and chat: name different chats: "${chat}" and "${parsed.chat}"`)
  }
  if (parsed.in !== undefined) {
    throw new CliError("validation_error", "in: is not searched yet — a search covers the account it runs as")
  }
  const named = parsed.chat ?? chat
  const scope: SearchScope = { accounts: [account] }
  if (named !== undefined) scope.chat = { account, chatId: await storedChatId(messenger, named, store, account) }
  if (parsed.from?.toLowerCase() === "me") scope.outgoing = true
  else if (parsed.from !== undefined) {
    try {
      const person = pickPerson(parsed.from, await store.people(account.provider, { account: account.account }))
      scope.sender = { provider: account.provider, id: person.id }
    } catch (error) {
      if (error instanceof CliError && error.code === "not_found") {
        throw new CliError("not_found", `from:${parsed.from} — ${error.message}`)
      }
      throw error
    }
  }
  if (parsed.after !== undefined) scope.after = parsed.after
  if (parsed.before !== undefined) scope.before = parsed.before
  if (parsed.has.length > 0) {
    const held = await store.attachmentKinds()
    const unknown = parsed.has.find((kind) => !["attachment", "link", ...held].includes(kind))
    if (unknown !== undefined) {
      throw new CliError(
        "validation_error",
        `has:${unknown} — the store holds no ${unknown}; it holds ${["attachment", "link", ...held].join(", ")}`,
      )
    }
    scope.has = parsed.has
  }
  return [{ required: parsed.required, excluded: parsed.excluded }, scope]
}
