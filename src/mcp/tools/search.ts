import { CliError } from "@leemour/cli-core"
import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import { parseDuration } from "../../cli/settings.js"
import type { MessagesService } from "../../services/messages.js"
import type { SearchesService, SearchParams } from "../../services/searches.js"
import { syncInputs } from "../search-sync.js"
import { threadArgs, threadInputs } from "../thread-options.js"
import { chatOf, limit } from "../tool.js"

export const MESSAGES_SEARCH_DESCRIPTION =
  "Search the local store using the Lucene 9.12.3 profile, default AND, with strict Boolean matching. Legacy discovery is explicit with language=legacy. Text or a versioned AST, account-scoped filters, calendar timezone, term/body regex and candidate presets use one service. Empty hits still report archive coverage. `saved` runs a saved search (searches_list) or an earlier run (searches_history). With sync_first, first fetch new messages within max_chats (5), sync_time (30s), max_messages (500), under messages.sync-first permission. A failed or bounded refresh keeps local results with stale coverage and refreshed details. thread=true attaches each hit's bounded parent/reply graph, with provenance and stale-edge labels; thread_hops, thread_messages, thread_bytes, thread_within set its separate bounds. Guide: https://github.com/leemour/cli-messaging/blob/main/docs/search/query-language.md. Returns { items, page, limit, hasMore, corrections, completeness, wordsReady, query, coverage }."

export const messagesSearchInput = (messenger: Messenger) =>
  v.object({
    ...threadInputs,
    ...syncInputs,
    text: v.optional(v.pipe(v.string(), v.description("the query: Lucene text or explicit legacy syntax"))),
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
    saved: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.description(
          "run a saved search (name) or an earlier run (id); text is AND-ed to it, other arguments replace its own",
        ),
      ),
    ),
  })

export const syncArgs = (args: {
  sync_first?: boolean
  max_chats?: number
  sync_time?: string
  max_messages?: number
}) =>
  args.sync_first
    ? {
        syncFirst: {
          ...(args.max_chats === undefined ? {} : { maxChats: args.max_chats }),
          ...(args.sync_time === undefined ? {} : { timeMs: parseDuration(args.sync_time, "sync_time") }),
          ...(args.max_messages === undefined ? {} : { maxMessages: args.max_messages }),
        },
      }
    : {}

export type MessagesSearchArgs = v.InferOutput<ReturnType<typeof messagesSearchInput>>

const typedOf = (args: Record<string, unknown>): SearchParams =>
  Object.fromEntries(
    ["text", "language", "timezone", "chat", "source", "newest", "context", "limit", "by"].flatMap((key) =>
      args[key] === undefined ? [] : [[key, args[key]]],
    ),
  )

/** `saved` needs the searches service; a host that mounts the tool without it refuses `saved` rather than ignore it. */
const resolveSaved = async (
  searches: Pick<SearchesService, "resolve"> | undefined,
  args: { saved?: string; ast?: unknown } & Record<string, unknown>,
) => {
  if (args.saved === undefined) return undefined
  if (!searches) throw new CliError("validation_error", "saved searches are not available on this server")
  if (args.ast !== undefined) throw new CliError("validation_error", "with saved, give more words as text, not an AST")
  return searches.resolve(args.saved, typedOf(args))
}

export const answerMessagesSearch = async (
  messages: Pick<MessagesService, "search">,
  args: MessagesSearchArgs,
  defaults: { limit: number; signal?: AbortSignal },
  searches?: Pick<SearchesService, "resolve">,
) => {
  const resolved = await resolveSaved(searches, args)
  if (resolved) {
    const { params, pattern } = resolved
    const size = params.limit ?? defaults.limit
    const found = await messages.search({
      ...syncArgs(args),
      ...threadArgs(args),
      ...(pattern ? { pattern } : params.text === undefined ? {} : { text: params.text }),
      ...(params.ast === undefined ? {} : { ast: params.ast }),
      language: params.language ?? (pattern ? "legacy" : "lucene"),
      signal: defaults.signal,
      ...(params.timezone === undefined ? {} : { timezone: params.timezone }),
      limit: size,
      newest: params.newest === true,
      context: params.context ?? 0,
      ...(params.chat === undefined ? {} : { chat: params.chat }),
      ...(params.source === undefined ? {} : { source: params.source }),
      saved: resolved.id,
    })
    return { ...found, page: 1, limit: size }
  }
  if (args.text === undefined && args.ast === undefined)
    throw new CliError("validation_error", "give search text, a versioned AST, or saved")
  const size = args.limit ?? defaults.limit
  const found = await messages.search({
    ...syncArgs(args),
    ...threadArgs(args),
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
  "Count what a strict Lucene query matches in the local store, by chat, sender, calendar day or hour (in the timezone). Each message is counted once; no text means every stored message. Counts are lower bounds where coverage is not complete. sync_first optionally refreshes within max_chats, sync_time and max_messages; failed refreshes keep counts with stale coverage and refreshed details. Returns { by, items: [{ key, name, account?, count }], total, hasMore, page, limit, query, coverage, completeness }."

export const messagesStatsInput = (messenger: Messenger) =>
  v.object({
    ...syncInputs,
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
    saved: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.description(
          "run a saved search (name) or an earlier run (id); text is AND-ed to it, other arguments replace its own",
        ),
      ),
    ),
  })

export const answerMessagesStats = async (
  messages: Pick<MessagesService, "stats">,
  args: v.InferOutput<ReturnType<typeof messagesStatsInput>>,
  defaults: { limit: number; signal?: AbortSignal },
  searches?: Pick<SearchesService, "resolve">,
) => {
  const resolved = await resolveSaved(searches, args)
  const params: SearchParams = resolved?.params ?? args
  if (params.regex || params.language === "legacy")
    throw new CliError(
      "validation_error",
      "stats messages show counts strict Lucene queries; this saved search is legacy",
    )
  const size = params.limit ?? defaults.limit
  const stats = await messages.stats({
    ...syncArgs(args),
    ...(params.text === undefined ? {} : { text: params.text }),
    ...(params.ast === undefined ? {} : { ast: params.ast }),
    by: params.by ?? "chat",
    language: "lucene",
    signal: defaults.signal,
    ...(params.timezone === undefined ? {} : { timezone: params.timezone }),
    limit: size,
    ...(params.chat === undefined ? {} : { chat: params.chat }),
    ...(params.source === undefined ? {} : { source: params.source }),
    ...(resolved ? { saved: resolved.id } : {}),
  })
  return { ...stats, page: 1, limit: size }
}
