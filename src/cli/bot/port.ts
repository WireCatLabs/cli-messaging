import type { Command } from "commander"
import type { Markup } from "../../domain/markdown.js"
import type { Chat, Id, Message, Provider } from "../../domain/models.js"
import type { Upload } from "../../sends/upload.js"
import type { PersonFacts } from "../../store/index.js"
import type { AppIdentity } from "../app.js"
import type { MessagePins, MessengerCore } from "../messenger/port.js"
import type { EventSink } from "../runs/events.js"
import type { GlobalFlags, ResolveOptions, Settings } from "../settings.js"
import type { ChatRegistry } from "./registry.js"
import type { BotTokenStore } from "./token.js"

/**
 * A chat as a bot command names it, resolved: a chat id, or `user:<id>` for the dialog with a person —
 * MAX's Bot API writes to a person by user id, and Telegram's chat id for a dialog is the person's id.
 */
export type BotChatRef = string

/** How one bot message goes. A bot send is never repeated — neither Bot API makes a repeat safe — so it has no send id. */
export interface BotSendOptions {
  /** A message id in the same chat. */
  replyTo?: Id
  silent?: boolean
  /** Spans of `text`, from `--md`. */
  markup?: Markup[]
  /** `text` is the messenger's HTML. */
  html?: boolean
  attachments?: Upload[]
}

/** Sending, changing and deleting the bot's messages. */
export interface BotMessaging {
  send(chat: BotChatRef, text: string, options: BotSendOptions): Promise<Message>
  edit(chat: BotChatRef, messageId: Id, text: string, options: { markup?: Markup[]; html?: boolean }): Promise<Message>
  delete(chat: BotChatRef, messageIds: Id[]): Promise<void>
}

/** Reading from the messenger, where its Bot API allows it — MAX's does, Telegram's does not. */
export interface BotHistory {
  /** The newest `limit`, oldest first. */
  history(chat: BotChatRef, window: { limit: number }): Promise<Message[]>
  message(chat: BotChatRef, messageId: Id): Promise<Message>
}

/** Who wrote what the adapter read, with what a `Message` has no field for. */
export interface BotPeople {
  /** The senders of the messages decoded since the last call — their handle and whether each is a bot — for the local copy. */
  senders(): PersonFacts[]
}

/** What a bot shows in a chat while it works. */
export const BOT_ACTIONS = ["typing", "photo", "video", "voice", "file"] as const
export type BotAction = (typeof BOT_ACTIONS)[number]

/** One chat the bot is in. */
export interface BotChatTools {
  chat(chat: BotChatRef): Promise<Chat>
  /** Only an admin of the chat can bring the bot back. */
  leave(chat: BotChatRef): Promise<void>
  action(chat: BotChatRef, action: BotAction): Promise<void>
}

/**
 * The part of the personal core a bot can do, and the groups its Bot API has. A bot never gets
 * `chats` from this type: neither Bot API lists a bot's chats.
 */
export type BotAdapter = Pick<MessengerCore, "me" | "close"> &
  Partial<BotMessaging> &
  Partial<BotHistory> &
  Partial<MessagePins> &
  Partial<BotChatTools> &
  Partial<BotPeople>

export interface BotConnectOptions {
  stop?: AbortSignal
  events?: EventSink
}

/** What one messenger CLI hands the shared bot commands. */
export interface BotMessenger {
  app: AppIdentity
  /** How the store tells this messenger's bots from its personal accounts: `max-bot`, `telegram-bot`. */
  provider: Provider
  /** The messenger's own name, as its users write it — `MAX`, `Telegram`. */
  name?: string
  /** Called with `kind: "bot"`. */
  resolveSettings: (flags: GlobalFlags, options?: ResolveOptions) => Settings
  /**
   * A client for this token. `stop` ends a command that runs until told to, and its request in
   * flight; `events` is the run's, for each request's trace line and record.
   */
  connect: (command: Command, token: string, options?: BotConnectOptions) => Promise<BotAdapter>
  /** Where the token lives; the shared `BotTokenStore` when unset. A CLI's tests put their own here. */
  tokenStore?: (command: Command, profile: string) => BotTokenStore
  /** The chats the bot has seen; the shared `ChatRegistry` when unset. */
  registry?: (command: Command, profile: string) => ChatRegistry
  /** A secret typed at a hidden prompt or piped on stdin; the shared `readSecret` when unset. */
  readSecret?: (command: Command, prompt: string) => Promise<string>
}
