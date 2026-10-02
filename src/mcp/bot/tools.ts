import type { InputRequiredResult, ServerContext } from "@modelcontextprotocol/server"
import * as v from "valibot"
import { BOT_ACTIONS } from "../../cli/bot/port.js"
import type { PermissionKey } from "../../sends/permissions.js"
import type { ResolveChat } from "../confirm.js"

/** One run of a bot command: options as single `--name=value` tokens, then `--` and the positionals. */
export interface Invocation {
  options?: string[]
  positionals?: string[]
}

/** What a tool that is more than one command gets from the server. */
export interface BotToolKit {
  /** Runs `bot <words…>` with `--json`; `answer` answers the command's own questions, for a form already shown. */
  invoke: (
    words: readonly string[],
    invocation: Invocation,
    answer?: (question: string) => string | null,
  ) => Promise<unknown>
  confirmed: (
    tool: { name: string; title: string },
    resolveChat: ResolveChat,
    args: Record<string, unknown>,
    ctx: ServerContext,
    act: (resolved: Record<string, unknown>) => Promise<object>,
  ) => Promise<object | InputRequiredResult>
  resolveChat: ResolveChat
}

export interface BotTool {
  /** The command under `bot`; also the tool's name, `<cli>_bot_<words>`. Offered only when the command exists. */
  words: readonly string[]
  title: string
  description: string
  input: v.ObjectSchema<v.ObjectEntries, undefined>
  /**
   * A write, and the key its command's guard checks — written here, never read from the name: a
   * profile translated from old `allow` words opens only the keys those words stood for.
   */
  writes?: PermissionKey
  /** Reads the local copy by person or text, so it may reach other bots when `readOtherBots` allows. */
  across?: boolean
  invocation?: (args: Record<string, unknown>) => Invocation
  /** In place of `invocation`: a tool that is more than one command, with its own form. */
  handle?: (args: Record<string, unknown>, kit: BotToolKit, ctx: ServerContext) => Promise<object | InputRequiredResult>
}

/** A value never reaches commander as its own token, so no argument can become a flag. */
export const option = (name: string, value: unknown): string[] =>
  value === undefined ? [] : [`--${name}=${String(value)}`]
export const flag = (name: string, on: unknown): string[] => (on === true ? [`--${name}`] : [])
/** A message's `format`, as the shared commands take it: `--md` or `--html`. */
export const marks = (format: unknown): string[] =>
  format === "markdown" ? ["--md"] : format === "html" ? ["--html"] : []

export const chat = v.pipe(
  v.string(),
  v.minLength(1),
  v.description("a chat id (groups are negative), user:<id> for a person, or the title of a chat this bot has seen"),
)
export const text = v.pipe(v.string(), v.regex(/^(?!-$)[\s\S]+$/, "a text, and not only -"), v.description("the text"))
export const limit = v.optional(
  v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100), v.description("how many")),
)
export const format = v.optional(v.pipe(v.picklist(["markdown", "html"]), v.description("how the text is marked up")))
export const offline = v.optional(v.pipe(v.boolean(), v.description("answer from the copy on this machine only")))
export const person = v.pipe(v.string(), v.minLength(1), v.description("a person's id"))
export const message = v.pipe(
  v.string(),
  v.maxLength(256),
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
  v.regex(/^(?!-)[^\s\x00-\x1F\x7F-\x9F]+$/, "a message id has no spaces or control characters, and no - first"),
  v.description("message id"),
)

/** `all_bots` and `bots`, added to an `across` tool only when this bot may read others. */
export const withAcross = (tool: BotTool): BotTool => ({
  ...tool,
  input: v.object({
    ...tool.input.entries,
    all_bots: v.optional(v.pipe(v.boolean(), v.description("also read every other bot's copy this bot may read"))),
    bots: v.optional(
      v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.description("also read these bots' copies, by profile")),
    ),
  }),
  invocation: (args) => {
    const inner = tool.invocation?.(args) ?? {}
    const bots = args.bots as string[] | undefined
    return {
      ...inner,
      options: [...(inner.options ?? []), ...flag("all-bots", args.all_bots), ...option("bots", bots?.join(","))],
    }
  },
})

/** The shared bot commands an agent may run. The token, recipients, webhooks and menu stay the owner's. */
export const BOT_TOOLS: readonly BotTool[] = [
  {
    words: ["chats", "list"],
    title: "Chats this bot has seen",
    description: "Chats this bot has seen on this machine — a bot gets no list of its chats, so this is not complete.",
    input: v.object({}),
  },
  {
    words: ["chats", "show"],
    title: "One chat",
    description: "One chat: title, type, members count; the bot remembers it.",
    input: v.object({ chat }),
    invocation: (args) => ({ positionals: [String(args.chat)] }),
  },
  {
    words: ["messages", "list"],
    title: "Messages in a chat",
    description: "The latest messages in a chat, oldest first. With offline, only what this machine has kept.",
    input: v.object({ chat, limit, offline }),
    invocation: (args) => ({
      options: [...option("limit", args.limit), ...flag("offline", args.offline)],
      positionals: [String(args.chat)],
    }),
  },
  {
    words: ["messages", "show"],
    title: "One message",
    description: "One message by its id, in its chat.",
    input: v.object({ chat, message, offline }),
    invocation: (args) => ({
      options: flag("offline", args.offline),
      positionals: [String(args.chat), String(args.message)],
    }),
  },
  {
    words: ["chats", "admins", "list"],
    title: "Admins of a chat",
    description: "The admins of a chat and what each may do.",
    input: v.object({ chat }),
    invocation: (args) => ({ positionals: [String(args.chat)] }),
  },
  {
    words: ["commands", "list"],
    title: "The bot's command menu",
    description: "The commands people see after typing / in a chat with the bot.",
    input: v.object({}),
  },
  {
    words: ["sends", "list"],
    title: "What the bot wrote",
    description: "What this bot sent, edited and deleted from this machine: ids and outcomes, never text.",
    input: v.object({}),
  },
  {
    words: ["recipients", "list"],
    title: "Where the bot may write",
    description: "The chats this bot may write to; empty means any chat. Only the owner changes it.",
    input: v.object({}),
  },

  {
    words: ["messages", "send"],
    writes: "bot.messages.send",
    title: "Send a message as the bot",
    description:
      "Send a text message as the bot to a chat, or to a person as user:<id>. Only when the owner asked for this " +
      "message in this chat.",
    input: v.object({
      chat,
      text,
      format,
      reply_to: v.optional(message),
      silent: v.optional(v.pipe(v.boolean(), v.description("no notification"))),
    }),
    invocation: (args) => ({
      options: [...marks(args.format), ...option("reply-to", args.reply_to), ...flag("silent", args.silent)],
      positionals: [String(args.chat), String(args.text)],
    }),
  },
  {
    words: ["messages", "edit"],
    writes: "bot.messages.edit",
    title: "Edit the bot's message",
    description: "Replace the text of a message the bot sent.",
    input: v.object({ chat, message, text, format }),
    invocation: (args) => ({
      options: marks(args.format),
      positionals: [String(args.chat), String(args.message), String(args.text)],
    }),
  },
  {
    words: ["messages", "pin"],
    writes: "bot.messages.pin",
    title: "Pin a message",
    description: "Pin a message in a chat, quietly.",
    input: v.object({ chat, message }),
    invocation: (args) => ({ positionals: [String(args.chat), String(args.message)] }),
  },
  {
    words: ["messages", "unpin"],
    writes: "bot.messages.unpin",
    title: "Unpin",
    description: "Unpin a pinned message in a chat.",
    input: v.object({ chat, message }),
    invocation: (args) => ({ positionals: [String(args.chat), String(args.message)] }),
  },
  {
    words: ["chats", "action"],
    writes: "bot.chats.action",
    title: "Show that the bot is typing",
    description: "Show an action in the chat, such as typing, while the bot prepares an answer.",
    input: v.object({ chat, action: v.picklist(BOT_ACTIONS) }),
    invocation: (args) => ({ positionals: [String(args.chat), String(args.action)] }),
  },
  {
    words: ["callbacks", "answer"],
    writes: "bot.callbacks.answer",
    title: "Answer a pressed button",
    description:
      "Answer a button a person pressed under the bot's message: notification shows them a note, text replaces " +
      "the message. The recipient list cannot apply: a button press does not name its chat.",
    input: v.object({
      callback: v.pipe(v.string(), v.regex(/^[\w.:-]+$/, "a callback id")),
      text: v.optional(text),
      notification: v.optional(v.pipe(v.string(), v.minLength(1))),
    }),
    invocation: (args) => ({
      options: [...option("text", args.text), ...option("notification", args.notification)],
      positionals: [String(args.callback)],
    }),
  },
  {
    words: ["messages", "delete"],
    writes: "bot.messages.delete",
    title: "Delete a message",
    description: "Delete a message in a chat where the bot may delete. It cannot be undone.",
    input: v.object({ chat, message }),
    invocation: (args) => ({ positionals: [String(args.chat), String(args.message)] }),
  },
  {
    words: ["chats", "members", "remove"],
    writes: "bot.chats.members.remove",
    title: "Remove a person from a chat",
    description: "Remove a person from a group chat; block keeps them from coming back by the link.",
    input: v.object({ chat, user: person, block: v.optional(v.boolean()) }),
    invocation: (args) => ({ options: flag("block", args.block), positionals: [String(args.chat), String(args.user)] }),
  },
]
