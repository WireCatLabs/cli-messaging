import { CliError } from "@leemour/cli-core"
import type { Markup } from "../../domain/markdown.js"
import type {
  Account,
  AccountSession,
  Chat,
  ChatCard,
  ChatEvents,
  GroupMember,
  Id,
  Member,
  Message,
  MessageEvent,
  Page,
  PersonCard,
  WindowedMessage,
} from "../../domain/models.js"
import type { Upload } from "../../sends/upload.js"

/** One attachment's bytes, fetched over the adapter's connection when `bytes` is read — so read it before the command closes. */
export interface RemoteFile {
  kind: string
  /** As the sender named it: other people's text, never a path to trust. */
  name?: string
  mime?: string
  size?: number
  bytes(): AsyncIterable<Uint8Array>
}

/** A message's files, and the kinds of attachment it has that are not files — a poll, a location. */
export interface Download {
  files: RemoteFile[]
  skipped: string[]
}

/** How one message goes. `markup` spans `text` as sent — the marks already taken out of it. */
export interface SendOptions {
  sendId: string
  /** A message id in the same chat. */
  replyTo?: Id
  /** Delivered without a notification. */
  silent?: boolean
  /** No preview card for a link in the text. */
  noPreview?: boolean
  markup?: Markup[]
  /** ISO time: the messenger holds it and sends it then, under a new id. */
  at?: string
  /** Sent in one message, `text` as the caption. More than one is an album. */
  attachments?: Upload[]
}

/** A voice message as text. `pending`: the messenger was still working on it when it answered. */
export interface Transcript {
  text: string
  pending: boolean
}

/** A message id — exact within one chat — or a moment in ms, which works in every chat. */
export type After = { id: Id } | { time: number }

export interface Sent {
  message: Message
  /** The send's identity. Repeat it after an unknown outcome, never a new one. */
  sendId: string
}

/**
 * What a messenger does for the shared commands. Each CLI implements it over its own library, and
 * nothing of that library's shape crosses it. A chat is passed as typed — a title, an id, a handle —
 * because only the adapter knows how its messenger finds one.
 *
 * **A method added from now on is optional** (`edit?`), so an adapter or a test fake that lacks it
 * still compiles, and the command asks for it with `capability` — which refuses with a message
 * instead of crashing. Such a method returns a promise: the wrappers time and pass it through
 * without being told about it (`throughWrapper`).
 */
export interface MessengerAdapter {
  /** The logged-in account's id, from what is stored locally — no request. `null` before a login. */
  self(): Id | null
  me(): Promise<Account>
  chats(window: { limit?: number; offset: number }): Promise<Page<Chat>>
  /** Oldest to newest. `before` is a message id, or whatever the messenger pages by, as typed. */
  history(chat: string, window: { limit: number; before?: string }): Promise<Page<Message>>
  /** The oldest `limit` newer than a message or a moment, oldest first; `hasMore` when newer ones remain. */
  historyAfter?(chat: string, window: { limit: number; after: After }): Promise<Page<Message>>
  resolve(chat: string): Promise<Chat>
  /** One chat and who is in it; `members` is `null` where the messenger does not say — a channel, a hidden list. */
  chat(chat: string): Promise<ChatCard>
  /** One person and the chats this account shares with them, newest first. A chat that is not a person is refused. */
  contact(person: string): Promise<PersonCard>
  /** One message and up to `before` and `after` either side, oldest first; the one asked for carries `anchor`. */
  around(chat: string, messageId: Id, window: { before: number; after: number }): Promise<WindowedMessage[]>
  /** An option the messenger has no way to honour is refused, never dropped. */
  send(chatId: Id, text: string, options: SendOptions): Promise<Sent>
  /** The new text of one of the owner's own messages; the answer is the message as it now stands. */
  edit?(chatId: Id, messageId: Id, text: string): Promise<Message>
  /** One message into another chat; the answer is the copy there. `silent` delivers it without a notification. */
  forward?(fromChatId: Id, messageId: Id, toChatId: Id, options: { silent?: boolean }): Promise<Message>
  /** `notify` tells the chat's members; without it the pin is quiet. */
  pin?(chatId: Id, messageId: Id, options: { notify: boolean }): Promise<void>
  unpin?(chatId: Id, messageId: Id): Promise<void>
  /** The owner's reaction on one message: an emoji replaces the one there was, `null` takes it off. */
  react?(chatId: Id, messageId: Id, emoji: string | null): Promise<void>
  /** Marks the chat read up to `until`, or to its newest message; the other side sees it. */
  markRead?(chatId: Id, until?: Id): Promise<void>
  /**
   * New messages and changes to messages as they arrive, until `signal` aborts. `onReady` once it is
   * actually listening — a caller that sends on "listening" must not race the connection. Only on a
   * connection opened with `{ listen: true }`; a messenger that cannot listen leaves it out.
   */
  watch?(onEvent: (event: MessageEvent) => void, signal: AbortSignal, onReady?: () => void): Promise<void>
  /** The files attached to one message, fetched fresh from the messenger: a stored reference may have expired. */
  download?(chat: string, messageId: Id): Promise<Download>
  /** Messages waiting to be sent later in a chat, soonest first, each with `scheduledFor`. */
  scheduled?(chat: string): Promise<Message[]>
  /** A voice or video note as text, by the messenger's own speech recognition. */
  transcribe?(chat: string, messageId: Id): Promise<Transcript>
  /** Every device and app logged in to this account. Reading them ends nothing. */
  sessions?(): Promise<AccountSession[]>
  /** The person with this phone number, where their privacy lets the owner find them; `not_found` otherwise. */
  lookup?(phone: string): Promise<Member>
  /** The owner's contact list as the messenger keeps it — the address book, not the chats. */
  addressBook?(): Promise<Member[]>
  /** Everyone in a group, a page at a time; `limit` unset is every one the messenger will give. */
  members?(chat: string, window: { limit?: number; offset: number }): Promise<Page<GroupMember> & { chatId: Id }>
  /** Who joined, left, was added or removed since `since` (ms), from the chat's service messages. */
  chatEvents?(chat: string, window: { since: number }): Promise<ChatEvents>
  /** A group's admins, whose answer counts as the group's in `review --unanswered`; `null` where the group hides them. */
  admins?(chat: string): Promise<Id[] | null>
  logout(): Promise<void>
  close(): Promise<void>
}

type Method = (...args: never[]) => unknown

/**
 * `handled` for the methods a wrapper knows; any other method of `inner` still answers, through
 * `wrap`. So a method added to the adapter reaches the command without an edit to every wrapper.
 */
export const throughWrapper = (
  inner: MessengerAdapter,
  handled: MessengerAdapter,
  wrap: (name: string, call: (...args: unknown[]) => Promise<unknown>) => Method = (_, call) => call,
): MessengerAdapter =>
  new Proxy(handled, {
    get: (own, key) => {
      if (key in own) return own[key as keyof MessengerAdapter]
      const value = inner[key as keyof MessengerAdapter] as unknown
      return typeof value === "function"
        ? wrap(String(key), (...args) => (value as (...a: unknown[]) => Promise<unknown>).apply(inner, args))
        : value
    },
    has: (own, key) => key in own || key in inner,
  })

/** The adapter's `method`, or a refusal naming what this messenger cannot do. */
export const capability = <K extends keyof MessengerAdapter>(
  adapter: MessengerAdapter,
  method: K,
  what: string,
): NonNullable<MessengerAdapter[K]> => {
  const found = adapter[method]
  if (typeof found !== "function") throw new CliError("validation_error", `this messenger cannot ${what}`)
  return found.bind(adapter) as NonNullable<MessengerAdapter[K]>
}
