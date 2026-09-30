import * as v from "valibot"
import { afterOf, oneDirection } from "../../cli/messenger/after.js"
import type { Messenger } from "../../cli/messenger/context.js"
import { capability } from "../../cli/messenger/port.js"
import { onlineDeps, servicesFor, storedDeps } from "../../services/index.js"
import { heard, hearForTool } from "../../speech/hearing.js"
import { type AnyTool, chatOf, limit, message, nameOf, READ, tool } from "../tool.js"

export const messagesTools = (messenger: Messenger): Record<string, AnyTool> => {
  const chat = chatOf(messenger)
  const name = nameOf(messenger)
  return {
    messages_list: tool({
      title: "Read a chat",
      description:
        "Recent messages in a chat, oldest first. Does not mark anything read. For older messages pass " +
        "`before` = the id of the first item; for newer ones, `after` = the id of the last item, or a time. " +
        "A voice message carries `transcript` once heard; `transcribe` hears the rest. Returns { items, limit, hasMore }.",
      input: v.object({
        chat,
        limit,
        before: v.optional(v.pipe(message, v.description("only messages older than this message id"))),
        after: v.optional(
          v.pipe(v.string(), v.description("only messages newer than this message id, ISO 8601 time, or 2h / 1d ago")),
        ),
        transcribe: v.optional(
          v.pipe(v.boolean(), v.description("turn voice messages not heard yet into text; can take minutes")),
        ),
      }),
      annotations: READ,
      online: async (adapter, args, defaults) => {
        const size = args.limit ?? defaults.limit
        oneDirection(args.before, args.after)
        const found = await servicesFor(onlineDeps(messenger, adapter, defaults.guard)).messages.list(args.chat, {
          limit: size,
          ...(args.before === undefined ? {} : { before: args.before }),
          ...(args.after === undefined ? {} : { after: afterOf(args.after, "after") }),
        })
        const hearing = await hearForTool(messenger, adapter, found.items, args.transcribe === true, defaults)
        return {
          items: heard(found.items, hearing),
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
        "carries anchor: true. Returns { items }.",
      input: v.object({
        chat,
        message,
        before: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100))),
        after: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100))),
      }),
      annotations: READ,
      online: async (adapter, args, defaults) => ({
        items: await servicesFor(onlineDeps(messenger, adapter, defaults.guard)).messages.around(
          args.chat,
          args.message,
          {
            before: args.before ?? 0,
            after: args.after ?? 0,
          },
        ),
      }),
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
