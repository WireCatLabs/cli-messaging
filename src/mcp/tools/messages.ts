import * as v from "valibot"
import { listStart } from "../../cli/messenger/after.js"
import type { Messenger } from "../../cli/messenger/context.js"
import { capability } from "../../cli/messenger/port.js"
import { listed } from "../../cli/paging.js"
import { readEvidencePacket, servicesFor, storedDeps } from "../../services/index.js"
import { heard, hearForTool, modelWith } from "../../speech/hearing.js"
import { type AnyTool, chatOf, limit, message, nameOf, READ, snakeOf, tool } from "../tool.js"

export const messagesTools = (messenger: Messenger): Record<string, AnyTool> => {
  const chat = chatOf(messenger)
  const name = nameOf(messenger)
  return {
    messages_evidence: tool({
      title: "Prepare stored chat evidence",
      description:
        "A chat evidence packet from the current profile's local archive, newest first. Never connects or marks " +
        "read. Whole messages fill at most 64 KiB of JSON items; the packet envelope is additional. Returns " +
        "source locators, fingerprints, coverage (history unknown) and nextBeforeId. Pass a non-null cursor as " +
        "before_id for older messages. An oversized first message returns an empty, byte-truncated packet " +
        "with no cursor; handle that obstruction explicitly. Prepares evidence, not a generated summary.",
      input: v.object({
        chat,
        limit,
        before_id: v.optional(v.pipe(message, v.description("only messages older than this message id"))),
      }),
      annotations: { ...READ, openWorldHint: false },
      stored: (store, account, args, defaults) =>
        readEvidencePacket(
          store,
          account,
          {
            chat: args.chat,
            limit: args.limit ?? defaults.limit,
            ...(args.before_id === undefined ? {} : { before: args.before_id }),
          },
          messenger,
        ),
    }),

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
        '"not in what was kept", not "never said" (see completeness). Every word must appear, best match ' +
        'first; "a phrase", -word, a OR b, and from: chat: after: before: has: in: work as in the CLI. A typo is ' +
        "corrected (listed in corrections); with no match it falls back to any word, then to a piece of a " +
        "word — each hit says which in match, and score is its relevance, higher better. It searches the " +
        "account it runs as; `source` (a messenger; personal, bots or all) searches every account of it held on this machine, " +
        "and each hit's locator names its messenger and account. Returns { items, limit, hasMore, corrections, completeness, wordsReady }.",
      input: v.object({
        text: v.pipe(v.string(), v.minLength(1), v.description("the query: words, phrases and filters")),
        chat: v.optional(chat),
        source: v.optional(
          v.pipe(
            v.string(),
            v.minLength(1),
            v.description("a messenger held on this machine; personal, bots or all — as in: in text"),
          ),
        ),
        newest: v.optional(v.pipe(v.boolean(), v.description("newest first instead of best first"))),
        context: v.optional(
          v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(20), v.description("messages around each hit")),
        ),
        limit,
      }),
      annotations: { ...READ, openWorldHint: false },
      stored: async (store, account, args, defaults) => {
        const size = args.limit ?? defaults.limit
        const found = await servicesFor(storedDeps(messenger, store, account, defaults.guard)).messages.search({
          text: args.text,
          limit: size,
          newest: args.newest === true,
          context: args.context ?? 0,
          ...(args.chat === undefined ? {} : { chat: args.chat }),
          ...(args.source === undefined ? {} : { source: args.source }),
        })
        return { ...found, limit: size }
      },
    }),
  }
}
