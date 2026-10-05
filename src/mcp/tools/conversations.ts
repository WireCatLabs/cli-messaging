import { CliError } from "@leemour/cli-core"
import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import { listed } from "../../cli/paging.js"
import { REFRESH_BOUNDS } from "../../services/embeddings.js"
import { servicesFor, storedDeps } from "../../services/index.js"
import { momentOf } from "../../services/moment.js"
import { searchServices, syncInputs } from "../search-sync.js"
import { type AnyTool, chatOf, limit, message, READ, refuseAskedLocalWrite, tool } from "../tool.js"
import { syncArgs } from "./search.js"

/** An MCP client gives up on a call long before 2,000 chunks are embedded. */
const MCP_MAX_CHUNKS = 500

/** Reads, and `conversations_refresh`, which writes derived indexes to the local store and never to the messenger. */
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
        const page = await servicesFor({
          ...storedDeps(messenger, store, account, defaults.guard),
          env: defaults.env,
          profile: defaults.settings.profile,
        }).conversations.list(args.chat, {
          limit: size,
          ...(args.since === undefined ? {} : { since: new Date(momentOf(args.since, "since")).toISOString() }),
        })
        return { items: page.items, limit: size, hasMore: page.hasMore }
      },
    }),

    conversations_search: tool({
      title: "Search conversations by meaning and words",
      description:
        "The conversations nearest to `query`, best first, in one chat or every chat: by meaning in the chats " +
        `embedded with \`${command} conversations embed --chat <chat>\` (a model on this machine), and by the ` +
        "words they share, the two lists merged. Returns { model, meaning, items, limit, readiness, " +
        "embeddedOnlyElsewhere }; each item has the conversation's summary, the chunk that matched, `by` " +
        "(meaning, words or both), a `score`, the meaning's cosine, null when only words found it, and `stale`, " +
        "true when the chunk changed after it was embedded — its id goes to conversations_show. `meaning` is " +
        `"unavailable" when the model is not downloaded (\`${command} models text download\`) and only words ` +
        "were searched. readiness lists chat ids: searchedByMeaning, wordsOnly, partial (some chunks not " +
        "embedded), stale (changed since the build) and notBuilt. embeddedOnlyElsewhere names chats embedded " +
        "only with another model. filter is strict Lucene: any message in the conversation must match before ranking. " +
        "source explicitly widens accounts; by default only the active account is searched. Hits include source and locator. " +
        "sync_first optionally fetches new messages first under messages.sync-first; max_chats (5), sync_time (30s) " +
        "and max_messages (500) bound the fetch. This does not build or embed; refreshed describes the network step " +
        "and incomplete refreshes label coverage stale.",
      input: v.object({
        ...syncInputs,
        query: v.pipe(v.string(), v.minLength(1), v.description("what to look for, in your own words")),
        filter: v.optional(v.pipe(v.string(), v.minLength(1))),
        source: v.optional(v.pipe(v.string(), v.minLength(1))),
        timezone: v.optional(v.pipe(v.string(), v.minLength(1))),
        chat: v.optional(chat),
        since: v.optional(
          v.pipe(v.string(), v.description("only those still going at this ISO 8601 time, or 2h / 1d ago, or later")),
        ),
        limit,
      }),
      annotations: { ...READ, openWorldHint: false },
      stored: async (store, account, args, defaults, connect) => {
        const size = args.limit ?? defaults.limit
        const found = await searchServices(messenger, store, account, defaults, connect).embeddings.search(args.query, {
          ...syncArgs(args),
          signal: defaults.signal,
          limit: size,
          ...(args.filter === undefined ? {} : { filter: args.filter }),
          ...(args.source === undefined ? {} : { source: args.source }),
          ...(args.timezone === undefined ? {} : { timezone: args.timezone }),
          ...(args.chat === undefined ? {} : { chat: args.chat }),
          ...(args.since === undefined ? {} : { since: new Date(momentOf(args.since, "since")).toISOString() }),
        })
        return {
          accounts: found.accounts,
          ...(found.refreshed ? { refreshed: found.refreshed, coverage: found.coverage } : {}),
          model: found.model,
          meaning: found.meaning,
          items: found.hits,
          limit: size,
          readiness: found.readiness,
          embeddedOnlyElsewhere: found.embeddedOnlyElsewhere,
        }
      },
    }),

    conversations_related: tool({
      title: "Find conversations like the one a message is in",
      description:
        "The conversations nearest in meaning to the one `message` is in, in every built chat, best first, never " +
        "that one. Uses the vectors stored by " +
        `\`${command} conversations embed\`: no model runs. Returns { model, source, items, limit, readiness }: ` +
        "source is the message's conversation; each item has the conversation's summary, the chunk that matched, " +
        "`score` (cosine) and `stale`, true when the chunk changed after it was embedded — its id goes to " +
        "conversations_show. readiness lists chat ids as conversations_search does. Refused, naming the " +
        "command, when the message's conversation has no vector that matches its messages now.",
      input: v.object({ chat, message, limit }),
      annotations: { ...READ, openWorldHint: false },
      stored: async (store, account, args, defaults) => {
        const size = args.limit ?? defaults.limit
        const found = await servicesFor({
          ...storedDeps(messenger, store, account, defaults.guard),
          env: defaults.env,
          profile: defaults.settings.profile,
        }).embeddings.related(args.chat, args.message, { limit: size })
        return { model: found.model, source: found.source, items: found.hits, limit: size, readiness: found.readiness }
      },
    }),

    conversations_status: tool({
      title: "Check how fresh conversations are",
      description:
        "How fresh each built chat's conversations and vectors are, or one chat's: state (ready, stale, " +
        "partial, words-only, not-built), the build's time and rules, messages it has not seen (new, edited, " +
        "deleted) and chunks with a current, stale or missing vector of the default model. Returns " +
        "{ items, page, limit, hasMore, model, unbuiltGroups? } — unbuiltGroups, without chat, counts group " +
        `chats never built. Fix with \`${command} conversations build\` and \`embed\`.`,
      input: v.object({ chat: v.optional(chat) }),
      annotations: { ...READ, openWorldHint: false },
      stored: async (store, account, args, defaults) => {
        const found = await servicesFor({
          ...storedDeps(messenger, store, account, defaults.guard),
          env: defaults.env,
          profile: defaults.settings.profile,
        }).embeddings.readiness(args.chat === undefined ? {} : { chat: args.chat })
        return {
          ...listed(found.chats),
          model: found.model,
          ...(found.unbuiltGroups === undefined ? {} : { unbuiltGroups: found.unbuiltGroups }),
        }
      },
    }),

    conversations_refresh: tool({
      title: "Bring conversations and vectors up to date",
      description:
        "Builds, then embeds with the model on this machine, the chats that changed since their build and the " +
        "group chats never built — or only `chat` — at most `max_chats` chats " +
        `(${REFRESH_BOUNDS.maxChats}) and \`max_chunks\` chunks (${MCP_MAX_CHUNKS}) per call; call again for the ` +
        "rest. Writes only to the local store: nothing is sent, no model is downloaded and no remote model is " +
        "used. Returns { model, modelAvailable, built, embedded, left }; `left` lists chats that still need " +
        "`build` or `embed`. modelAvailable false means nothing was embedded: " +
        `\`${command} models text download\`. What \`${command} conversations search --refresh\` runs first.`,
      input: v.object({
        chat: v.optional(chat),
        max_chats: v.optional(
          v.pipe(v.number(), v.integer(), v.minValue(1), v.description("at most this many chats in one run")),
        ),
        max_chunks: v.optional(
          v.pipe(v.number(), v.integer(), v.minValue(1), v.description("at most this many chunks embedded in one run")),
        ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      key: "conversations.embed",
      stored: async (store, account, args, defaults) => {
        refuseAskedLocalWrite(defaults, "conversations.embed", command)
        const deps = {
          ...storedDeps(messenger, store, account, defaults.guard),
          env: defaults.env,
          profile: defaults.settings.profile,
          embedders: defaults.embedders,
        }
        return servicesFor(deps).embeddings.refresh({
          ...(args.chat === undefined ? {} : { chat: args.chat }),
          maxChats: args.max_chats ?? REFRESH_BOUNDS.maxChats,
          maxChunks: args.max_chunks ?? MCP_MAX_CHUNKS,
        })
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
        const services = servicesFor({
          ...storedDeps(messenger, store, account, defaults.guard),
          env: defaults.env,
          profile: defaults.settings.profile,
        })
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
