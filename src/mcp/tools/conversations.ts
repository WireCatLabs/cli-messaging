import { CliError } from "@leemour/cli-core"
import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import { listed } from "../../cli/paging.js"
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
        "only with another model.",
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
        const deps = { ...storedDeps(messenger, store, account, defaults.guard), embedders: defaults.embedders }
        const found = await servicesFor(deps).embeddings.search(args.query, {
          limit: size,
          ...(args.chat === undefined ? {} : { chat: args.chat }),
          ...(args.since === undefined ? {} : { since: new Date(momentOf(args.since, "since")).toISOString() }),
        })
        return {
          model: found.model,
          meaning: found.meaning,
          items: found.hits,
          limit: size,
          readiness: found.readiness,
          embeddedOnlyElsewhere: found.embeddedOnlyElsewhere,
        }
      },
    }),

    conversations_status: tool({
      title: "Check how fresh conversations are",
      description:
        "How fresh each built chat's conversations and vectors are, or one chat's: state (ready, stale, " +
        "partial, words-only, not-built), the build's time and rules, messages it has not seen (new, edited, " +
        "deleted) and chunks with a current, stale or missing vector of the default model. Returns " +
        `{ items, page, limit, hasMore, model }. Fix with \`${command} conversations build\` and \`embed\`.`,
      input: v.object({ chat: v.optional(chat) }),
      annotations: { ...READ, openWorldHint: false },
      stored: async (store, account, args, defaults) => {
        const found = await servicesFor(storedDeps(messenger, store, account, defaults.guard)).embeddings.readiness(
          args.chat === undefined ? {} : { chat: args.chat },
        )
        return { ...listed(found.chats), model: found.model }
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
