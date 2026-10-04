import { CliError } from "@leemour/cli-core"
import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import type { MessagesService } from "../../services/messages.js"
import { chatOf, limit } from "../tool.js"

export const MESSAGES_SEARCH_DESCRIPTION =
  "Search only the local store using the Lucene 9.12.3 profile, default AND, with strict Boolean matching. Legacy discovery is explicit with language=legacy. Text or a versioned AST, account-scoped filters, calendar timezone, term/body regex and candidate presets use one service. Empty hits still report archive coverage. Guide: https://github.com/leemour/cli-messaging/blob/main/docs/search/query-language.md. Returns { items, page, limit, hasMore, corrections, completeness, wordsReady, query, coverage }."

export const messagesSearchInput = (messenger: Messenger) =>
  v.object({
    text: v.optional(
      v.pipe(v.string(), v.minLength(1), v.description("the query: Lucene text or explicit legacy syntax")),
    ),
    ast: v.optional(v.unknown()),
    language: v.optional(v.picklist(["lucene", "legacy"])),
    timezone: v.optional(v.string()),
    chat: v.optional(chatOf(messenger)),
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
  })

export type MessagesSearchArgs = v.InferOutput<ReturnType<typeof messagesSearchInput>>

export const answerMessagesSearch = async (
  messages: Pick<MessagesService, "search">,
  args: MessagesSearchArgs,
  defaults: { limit: number; signal?: AbortSignal },
) => {
  if (args.text === undefined && args.ast === undefined)
    throw new CliError("validation_error", "give search text or a versioned AST")
  const size = args.limit ?? defaults.limit
  const found = await messages.search({
    ...(args.text === undefined ? {} : { text: args.text }),
    ...(args.ast === undefined ? {} : { ast: args.ast }),
    language: args.language ?? "lucene",
    signal: defaults.signal,
    ...(args.timezone === undefined ? {} : { timezone: args.timezone }),
    limit: size,
    newest: args.newest === true,
    context: args.context ?? 0,
    ...(args.chat === undefined ? {} : { chat: args.chat }),
    ...(args.source === undefined ? {} : { source: args.source }),
  })
  return { ...found, page: 1, limit: size }
}

export const MESSAGES_STATS_DESCRIPTION =
  "Count what a strict Lucene query matches in the local store, by chat, sender, calendar day or hour (in the timezone). Each message is counted once; no text means every stored message. Counts are lower bounds where coverage is not complete. Returns { by, items: [{ key, name, account?, count }], total, hasMore, page, limit, query, coverage, completeness }."

export const messagesStatsInput = (messenger: Messenger) =>
  v.object({
    text: v.optional(v.pipe(v.string(), v.minLength(1), v.description("a strict Lucene query; omit to count all"))),
    ast: v.optional(v.unknown()),
    by: v.optional(v.picklist(["chat", "sender", "day", "hour"])),
    timezone: v.optional(v.string()),
    chat: v.optional(chatOf(messenger)),
    source: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.description("a messenger held on this machine; personal, bots or all — as in: in text"),
      ),
    ),
    limit,
  })

export const answerMessagesStats = async (
  messages: Pick<MessagesService, "stats">,
  args: v.InferOutput<ReturnType<typeof messagesStatsInput>>,
  defaults: { limit: number; signal?: AbortSignal },
) => {
  const size = args.limit ?? defaults.limit
  const stats = await messages.stats({
    ...(args.text === undefined ? {} : { text: args.text }),
    ...(args.ast === undefined ? {} : { ast: args.ast }),
    by: args.by ?? "chat",
    language: "lucene",
    signal: defaults.signal,
    ...(args.timezone === undefined ? {} : { timezone: args.timezone }),
    limit: size,
    ...(args.chat === undefined ? {} : { chat: args.chat }),
    ...(args.source === undefined ? {} : { source: args.source }),
  })
  return { ...stats, page: 1, limit: size }
}
