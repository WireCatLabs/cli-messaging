import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import { REVIEW_DAYS, reviewStart, UNANSWERED_HOURS } from "../../services/inbox.js"
import { momentOf } from "../../services/moment.js"
import { heard, hearForTool, modelWith } from "../../speech/hearing.js"
import { type AnyTool, chatOf, READ, tool } from "../tool.js"

export const reviewTools = (messenger: Messenger): Record<string, AnyTool> => ({
  review: tool({
    title: "Review who owes what",
    description:
      "Every message, the owner's too (outgoing: true), in each chat that changed since a point — for sorting out " +
      `what the owner owes and what others owe. Without \`since_time\`, the last ${REVIEW_DAYS} days. Muted and archived ` +
      "chats are left out unless they mention the owner, or `all` is set. Returns { since, until, complete, chats: " +
      "[{ id, title, messages, more }], skipped, partial, quiet }; when complete, the next review starts at until.",
    input: v.object({
      since_time: v.optional(
        v.pipe(v.string(), v.description("where the last review ended: ISO 8601, or 2h / 1d ago")),
      ),
      chat: v.optional(chatOf(messenger)),
      unanswered: v.optional(
        v.pipe(
          v.number(),
          v.minValue(0),
          v.description(
            `only questions nobody answered, asked at least this many hours ago (${UNANSWERED_HOURS} is usual)`,
          ),
        ),
      ),
      all: v.optional(v.pipe(v.boolean(), v.description("muted and archived chats too"))),
      transcribe: v.optional(
        v.pipe(v.boolean(), v.description("turn voice messages not heard yet into text; can take minutes")),
      ),
      model: v.optional(
        v.pipe(v.string(), v.minLength(1), v.description("which downloaded speech model hears them, with transcribe")),
      ),
    }),
    annotations: READ,
    served: async (services, args, defaults, connect) => {
      const model = modelWith(args.transcribe, args.model)
      const found = await services.inbox.review({
        since: args.since_time === undefined ? reviewStart() : momentOf(args.since_time, "since_time"),
        ...(args.chat === undefined ? {} : { chat: args.chat }),
        ...(args.all ? { all: true } : {}),
        ...(args.unanswered === undefined ? {} : { unansweredAfterHours: args.unanswered }),
      })
      const transcribe = args.transcribe === true
      const hearing = await hearForTool(
        messenger,
        connect,
        found.chats.flatMap((chat) => chat.messages),
        transcribe,
        defaults,
        model,
      )
      return {
        ...found,
        complete: found.complete && (hearing?.unheard.length ?? 0) === 0,
        chats: found.chats.map((chat) => ({ ...chat, messages: heard(chat.messages, hearing) })),
        unheard: hearing?.unheard ?? [],
        ...(hearing?.problem === undefined ? {} : { transcribeProblem: hearing.problem }),
      }
    },
  }),
})
