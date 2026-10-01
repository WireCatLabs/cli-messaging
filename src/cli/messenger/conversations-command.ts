import { CliError } from "@leemour/cli-core"
import { Command } from "commander"
import { renderMessages } from "../../render/messages.js"
import { momentOf } from "../../services/moment.js"
import type { ConversationSummary } from "../../store/store.js"
import { positiveCount } from "../paging.js"
import { type Messenger, messengerContext } from "./context.js"

/**
 * `conversations`: the threads inside a group chat, found by rules over the stored messages — replies,
 * mentions, one sender's messages in a row. From the store alone; nothing is built until asked (phase 3).
 */
export const conversationsCommand = (messenger: Messenger): Command => {
  const conversations = new Command("conversations").description(
    "the conversations inside a chat, found in the stored messages by replies, mentions and who wrote next",
  )

  conversations
    .command("build")
    .description(
      "find a chat's conversations in what the store holds, replacing the last build; never asks the messenger",
    )
    .requiredOption("--chat <chat>", messenger.chatArgument)
    .action(async function (this: Command) {
      const { chat } = this.opts<{ chat: string }>()
      const context = messengerContext(this, messenger)
      const built = await context.withServices((services) => services.conversations.build(chat))
      if (context.format === "pretty") {
        context.streams.data(
          `${built.messages} messages → ${built.conversations} conversations, ${built.links} links (rules v${built.rulesVersion})\n`,
        )
      } else context.renderer.result(built)
    })

  conversations
    .command("list")
    .description("a chat's conversations, the newest first: when, how many messages, how many people")
    .requiredOption("--chat <chat>", messenger.chatArgument)
    .option("--since-time <time>", "only those that started at this ISO 8601 time, or 30m / 2h / 1d ago, or later")
    .option("--limit <n>", "how many", positiveCount("--limit"))
    .action(async function (this: Command) {
      const { chat, sinceTime: since } = this.opts<{ chat: string; sinceTime?: string }>()
      const context = messengerContext(this, messenger)
      const { limit } = context.settings
      const page = await context.withServices((services) =>
        services.conversations.list(chat, {
          limit,
          ...(since === undefined ? {} : { since: new Date(momentOf(since, "--since-time")).toISOString() }),
        }),
      )
      if (context.format === "pretty") {
        context.streams.data(page.items.map((one) => `${line(one)}\n`).join(""))
        if (page.items.length === 0) context.renderer.note("no conversations in that window")
      } else if (context.format === "jsonl") context.renderer.stream(page.items)
      else context.renderer.result({ items: page.items, limit, hasMore: page.hasMore })
    })

  conversations
    .command("show")
    .description("one conversation's messages, oldest first — by its id, or the one a message is in")
    .argument(
      "<conversation>",
      `a conversation id from \`conversations list\`; or ${messenger.chatArgument}, with a message`,
    )
    .argument("[message]", "a message id in that chat: show the conversation it is in")
    .action(async function (this: Command, first: string, message: string | undefined) {
      const context = messengerContext(this, messenger)
      if (message === undefined && !/^\d+$/.test(first)) {
        throw new CliError("validation_error", "a conversation id is a number; for a chat, name a message too")
      }
      const { summary, messages } = await context.withServices((services) =>
        services.conversations.show(message === undefined ? { id: first } : { chat: first, message }),
      )
      if (context.format === "pretty") {
        context.streams.data(
          `${line(summary)}\n\n${renderMessages(messages, {
            color: context.color,
            verbosity: context.settings.detail,
            senderColors: context.settings.senderColors,
            profile: context.profile,
            provider: messenger.provider,
            locale: messenger.app.locale,
          })}`,
        )
      } else if (context.format === "jsonl") context.renderer.stream(messages)
      else context.renderer.result({ ...summary, messages })
    })

  return conversations
}

/** `messages links`: why a message sits where it does in its conversation. */
export const linksCommand = (messenger: Messenger): Command =>
  new Command("links")
    .description("why a message is in its conversation: each link it has, and the chain of answers back to the start")
    .argument("<chat>", messenger.chatArgument)
    .argument("<message>", "the message id")
    .action(async function (this: Command, chat: string, message: string) {
      const context = messengerContext(this, messenger)
      const found = await context.withServices((services) => services.conversations.links(chat, message))
      if (context.format !== "pretty") {
        context.renderer.result(found)
        return
      }
      if (found.links.length === 0) {
        context.renderer.note("no links: it starts a conversation, or the chat is not built — `conversations build`")
      }
      context.streams.data(
        found.links
          .map(
            (link) =>
              `${link.chosen ? "→" : " "} ${link.parentId ?? "(starts)"}  ${link.source} ${link.kind} ` +
              `${link.confidence}  ${link.method}${link.stale ? "  stale" : ""}\n`,
          )
          .join("") + (found.chain.length > 0 ? `chain: ${[message, ...found.chain].join(" ← ")}\n` : ""),
      )
    })

const line = (one: ConversationSummary) =>
  `${one.id}  ${one.firstAt.slice(0, 16).replace("T", " ")}–${one.lastAt.slice(11, 16)}  ` +
  `${one.messageCount} messages · ${one.senders} people · from message ${one.firstMessageId}`
