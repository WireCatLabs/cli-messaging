import { CliError } from "@leemour/cli-core"
import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import { servicesFor, storedDeps } from "../../services/index.js"
import { momentOf } from "../../services/moment.js"
import { type AnyTool, chatOf, limit, message, READ, tool } from "../tool.js"

/** Read-only: building a chat's conversations is the command's, run when the owner asks for it. */
export const conversationsTools = (messenger: Messenger): Record<string, AnyTool> => {
  const chat = chatOf(messenger)
  const command = messenger.app.command
  return {
    conversations_list: tool({
      title: "List a chat's conversations",
      description:
        "The conversations inside a group chat, newest first, found in the stored messages by replies, mentions " +
        `and who wrote next. Only for a chat built with \`${command} conversations build --chat <chat>\`. ` +
        "Returns { items, limit, hasMore }; each item's id goes to conversations_show.",
      input: v.object({
        chat,
        since: v.optional(
          v.pipe(v.string(), v.description("only those started at this ISO 8601 time, or 2h / 1d ago, or later")),
        ),
        limit,
      }),
      annotations: { ...READ, openWorldHint: false },
      stored: async (store, account, args, defaults) => {
        const size = args.limit ?? defaults.limit
        const page = await servicesFor(storedDeps(messenger, store, account, defaults.guard)).conversations.list(
          args.chat,
          {
            limit: size,
            ...(args.since === undefined ? {} : { since: new Date(momentOf(args.since, "since")).toISOString() }),
          },
        )
        return { items: page.items, limit: size, hasMore: page.hasMore }
      },
    }),

    conversations_search: tool({
      title: "Search conversations by meaning",
      description:
        "The conversations nearest in meaning to `query`, best first, in one chat or every chat embedded with " +
        `\`${command} conversations embed --chat <chat>\`; runs a model on this machine. Returns { model, items, ` +
        "limit }; each item has the conversation's summary, the chunk that matched and a score — its id goes " +
        "to conversations_show.",
      input: v.object({
        query: v.pipe(v.string(), v.minLength(1), v.description("what to look for, in your own words")),
        chat: v.optional(chat),
        since: v.optional(
          v.pipe(v.string(), v.description("only those still going at this ISO 8601 time, or 2h / 1d ago, or later")),
        ),
        limit,
      }),
      annotations: { ...READ, openWorldHint: false },
      stored: async (store, account, args, defaults) => {
        const size = args.limit ?? defaults.limit
        const found = await servicesFor(storedDeps(messenger, store, account, defaults.guard)).embeddings.search(
          args.query,
          {
            limit: size,
            ...(args.chat === undefined ? {} : { chat: args.chat }),
            ...(args.since === undefined ? {} : { since: new Date(momentOf(args.since, "since")).toISOString() }),
          },
        )
        return { model: found.model, items: found.hits, limit: size }
      },
    }),

    conversations_show: tool({
      title: "Read a conversation",
      description:
        "One conversation's messages, oldest first: by `id` from conversations_list, or the conversation a " +
        "message is in (`chat` and `message`). Returns the summary with { messages }.",
      input: v.object({
        id: v.optional(v.pipe(v.string(), v.regex(/^\d+$/), v.description("conversation id"))),
        chat: v.optional(chat),
        message: v.optional(message),
      }),
      annotations: { ...READ, openWorldHint: false },
      stored: async (store, account, args, defaults) => {
        const services = servicesFor(storedDeps(messenger, store, account, defaults.guard))
        const target =
          args.id !== undefined
            ? { id: args.id }
            : args.chat !== undefined && args.message !== undefined
              ? { chat: args.chat, message: args.message }
              : undefined
        if (!target) throw new CliError("validation_error", "give `id`, or `chat` and `message`")
        const { summary, messages } = await services.conversations.show(target)
        return { ...summary, messages }
      },
    }),
  }
}
