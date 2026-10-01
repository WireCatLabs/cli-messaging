import { CliError } from "@leemour/cli-core"
import type { Command } from "commander"
import { SendJournal } from "../../sends/journal.js"
import { RecipientList } from "../../sends/recipients.js"
import { readSecret } from "../../terminal/prompt.js"
import { baseContext, environmentOf } from "../context.js"
import { asFirstWord } from "../profile.js"
import type { BotAdapter, BotConnectOptions, BotMessenger } from "./port.js"
import { botFiles, ChatRegistry } from "./registry.js"
import { BotTokenStore } from "./token.js"

/** How the owner types this bot — `max sales bot` — so a refusal names the command that fixes it. */
export const botWords = (bot: BotMessenger, profile: string): string => `${bot.app.command} ${asFirstWord(profile)}bot`

/** What a bot command needs, resolved once: the bot's settings, its token, its lists. */
export const botContext = (command: Command, bot: BotMessenger) => {
  const base = baseContext(command, (flags, options) => bot.resolveSettings(flags, { ...options, kind: "bot" }))
  const { settings, env } = base
  const profile = settings.profile
  const files = botFiles(bot.app, profile, env)
  const tokens = bot.tokenStore?.(command, profile) ?? new BotTokenStore({ app: bot.app, profile, env })
  const words = botWords(bot, profile)
  const connect = async (token: string, options: BotConnectOptions = {}): Promise<BotAdapter> => {
    const adapter = await bot.connect(command, token, options)
    base.track(adapter)
    return adapter
  }
  return {
    ...base,
    profile,
    words,
    tokens,
    registry: bot.registry?.(command, profile) ?? new ChatRegistry(bot.app, profile, env),
    recipients: () => new RecipientList(files.recipients, words),
    journal: () => new SendJournal(files.journal),
    readSecret: (prompt: string) => {
      const stdin = environmentOf(command).stdin
      return bot.readSecret?.(command, prompt) ?? readSecret(prompt, stdin ? { input: stdin } : {})
    },
    /** A client for this token, closed when the command ends. */
    connect,
    /** A client for the stored token, or a refusal that says how to store one. */
    authenticated: (options: BotConnectOptions = {}): Promise<BotAdapter> => {
      const stored = tokens.read()
      if (!stored) {
        throw new CliError("authentication_error", `no bot token for profile "${profile}" — run \`${words} auth set\``)
      }
      return connect(stored.token, options)
    },
  }
}

export type BotContext = ReturnType<typeof botContext>
