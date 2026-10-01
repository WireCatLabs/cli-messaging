import type { Command } from "commander"
import type { Provider } from "../../domain/models.js"
import type { AppIdentity } from "../app.js"
import type { MessengerCore } from "../messenger/port.js"
import type { GlobalFlags, ResolveOptions, Settings } from "../settings.js"
import type { ChatRegistry } from "./registry.js"
import type { BotTokenStore } from "./token.js"

/**
 * The part of the personal core a bot can do. It grows as bot commands move here; a bot never gets
 * `chats` or `history` from this type, because neither Bot API lists a bot's chats.
 */
export type BotAdapter = Pick<MessengerCore, "me" | "close">

/** What one messenger CLI hands the shared bot commands. */
export interface BotMessenger {
  app: AppIdentity
  /** How the store tells this messenger's bots from its personal accounts: `max-bot`, `telegram-bot`. */
  provider: Provider
  /** The messenger's own name, as its users write it — `MAX`, `Telegram`. */
  name?: string
  /** Called with `kind: "bot"`. */
  resolveSettings: (flags: GlobalFlags, options?: ResolveOptions) => Settings
  /** A client for this token; `stop` ends a command that runs until told to, and its request in flight. */
  connect: (command: Command, token: string, stop?: AbortSignal) => Promise<BotAdapter>
  /** Where the token lives; the shared `BotTokenStore` when unset. A CLI's tests put their own here. */
  tokenStore?: (command: Command, profile: string) => BotTokenStore
  /** The chats the bot has seen; the shared `ChatRegistry` when unset. */
  registry?: (command: Command, profile: string) => ChatRegistry
}
