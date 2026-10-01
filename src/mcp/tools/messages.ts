import * as v from "valibot"
import { listStart } from "../../cli/messenger/after.js"
import type { Messenger } from "../../cli/messenger/context.js"
import { capability } from "../../cli/messenger/port.js"
import { listed } from "../../cli/paging.js"
import { servicesFor, storedDeps } from "../../services/index.js"
import { heard, hearForTool, modelWith } from "../../speech/hearing.js"
import { type AnyTool, chatOf, limit, message, nameOf, READ, snakeOf, tool } from "../tool.js"

export const messagesTools = (messenger: Messenger): Record<string, AnyTool> => {
  const chat = chatOf(messenger)
  const name = nameOf(messenger)
  return {
    messages_list: tool({
      title: "Read a chat",
      description:
        "Recent messages in a chat, oldest first. Does not mark anything read. For older messages pass " +
        "`before_id` = the id of the first item, or `before_time`; for newer ones, `after_id` = the id of the last " +
        "item, or `after_time`. One of the four at most. A voice message carries `transcript` once heard; " +
        "`transcribe` hears the rest. Returns { items, page, limit, hasMore }.",
      input: v.object({
        chat,
        limit,
        before_id: v.optional(v.pipe(message, v.description("only messages older than this message id"))),
        before_time: v.optional(
          v.pipe(v.string(), v.description("only messages older than this ISO 8601 time, or 2h / 1d ago")),
        ),
        after_id: v.optional(v.pipe(message, v.description("only messages newer than this message id"))),
        after_time: v.optional(
          v.pipe(v.string(), v.description("only messages newer than this ISO 8601 time, or 2h / 1d ago")),
        ),
        transcribe: v.optional(
          v.pipe(v.boolean(), v.description("turn voice messages not heard yet into text; can take minutes")),
        ),
        model: v.optional(
          v.pipe(
            v.string(),
            v.minLength(1),
            v.description("which downloaded speech model hears them, with transcribe"),
          ),
        ),
      }),
      annotations: READ,
      served: async (services, args, defaults, connect) => {
        const size = args.limit ?? defaults.limit
        const start = listStart(
          {
            beforeId: args.before_id,
            beforeTime: args.before_time,
            afterId: args.after_id,
            afterTime: args.after_time,
          },
          snakeOf,
        )
        const found = await services.messages.list(args.chat, { limit: size, ...start })
        const hearing = await hearForTool(
          messenger,
          connect,
          found.items,
          args.transcribe === true,
          defaults,
          modelWith(args.transcribe, args.model),
        )
        return {
          items: heard(found.items, hearing),
          page: 1,
          limit: size,
          hasMore: found.hasMore,
          ...(args.transcribe ? { unheard: hearing?.unheard ?? [] } : {}),
        }
      },
    }),

    messages_context: tool({
      title: "Show a message",
      description:
        "One message by id, and optionally the messages either side of it, oldest first. The one asked for " +
        "carries anchor: true; `before_n` and `after_n` say how many either side. Returns { items, page, limit, hasMore }.",
      input: v.object({
        chat,
        message,
        before_n: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100))),
        after_n: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100))),
      }),
      annotations: READ,
      served: async (services, args) =>
        listed(
          await services.messages.around(args.chat, args.message, {
            before: args.before_n ?? 0,
            after: args.after_n ?? 0,
          }),
        ),
    }),

    messages_scheduled: tool({
      title: "Messages scheduled in a chat",
      description:
        "Messages waiting to be sent later in a chat, soonest first, each with scheduledFor. Look here after a " +
        `scheduled send ended in outcome_unknown. Cancelling one is done in the ${name} app. Returns { items }.`,
      input: v.object({ chat }),
      annotations: READ,
      online: async (adapter, args) => ({
        items: await capability(adapter, "scheduled", "list scheduled messages")(args.chat),
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
        const found = await servicesFor(storedDeps(messenger, store, account, defaults.guard)).messages.search({
          text: args.text,
          limit: size,
          ...(args.chat === undefined ? {} : { chat: args.chat }),
        })
        return { items: found.items, limit: size, hasMore: found.hasMore }
      },
    }),
  }
}
