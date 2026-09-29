import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import { storedChatId } from "../../cli/messenger/messages-command.js"
import { type AnyTool, chatOf, limit, message, nameOf, READ, tool } from "../tool.js"

export const messagesTools = (messenger: Messenger): Record<string, AnyTool> => {
  const chat = chatOf(messenger)
  const name = nameOf(messenger)
  return {
    messages_list: tool({
      title: "Read a chat",
      description:
        "Recent messages in a chat, oldest first. Does not mark anything read. For older messages pass " +
        "`before` = the id of the first item. Returns { items, limit, hasMore }.",
      input: v.object({
        chat,
        limit,
        before: v.optional(v.pipe(message, v.description("only messages older than this message id"))),
      }),
      annotations: READ,
      online: async (adapter, args, defaults) => {
        const size = args.limit ?? defaults.limit
        const found = await adapter.history(args.chat, {
          limit: size,
          ...(args.before === undefined ? {} : { before: args.before }),
        })
        return { items: found.items, limit: size, hasMore: found.hasMore }
      },
    }),

    messages_context: tool({
      title: "Show a message",
      description:
        "One message by id, and optionally the messages either side of it, oldest first. The one asked for " +
        "carries anchor: true. Returns { items }.",
      input: v.object({
        chat,
        message,
        before: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100))),
        after: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100))),
      }),
      annotations: READ,
      online: async (adapter, args) => ({
        items: await adapter.around(args.chat, args.message, { before: args.before ?? 0, after: args.after ?? 0 }),
      }),
    }),

    messages_search: tool({
      title: "Search messages",
      description:
        `Find messages in what this machine has kept — it never asks ${name}, so an empty answer means ` +
        '"not in what was kept", not "never said". Every word must appear, as a word or the start of one. ' +
        "Returns { items, limit, hasMore }.",
      input: v.object({
        text: v.pipe(v.string(), v.minLength(1), v.description("the words to look for")),
        chat: v.optional(chat),
        limit,
      }),
      annotations: { ...READ, openWorldHint: false },
      stored: async (store, account, args, defaults) => {
        const size = args.limit ?? defaults.limit
        const found = await store.find({
          text: args.text,
          account,
          limit: size,
          ...(args.chat === undefined ? {} : { chatId: await storedChatId(messenger, args.chat, store, account) }),
        })
        return { items: found.items, limit: size, hasMore: found.hasMore }
      },
    }),
  }
}
