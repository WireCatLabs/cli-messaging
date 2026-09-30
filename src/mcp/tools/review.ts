import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import { momentOf } from "../../cli/messenger/inbox.js"
import { REVIEW_DAYS, reviewStart, UNANSWERED_HOURS } from "../../cli/messenger/review.js"
import { onlineDeps, servicesFor } from "../../services/index.js"
import { type AnyTool, chatOf, READ, tool } from "../tool.js"

export const reviewTools = (messenger: Messenger): Record<string, AnyTool> => ({
  review: tool({
    title: "Review who owes what",
    description:
      "Every message, the owner's too (outgoing: true), in each chat that changed since a point — for sorting out " +
      `what the owner owes and what others owe. Without \`since\`, the last ${REVIEW_DAYS} days. Muted and archived ` +
      "chats are left out unless they mention the owner, or `all` is set. Returns { since, until, complete, chats: " +
      "[{ id, title, messages, more }], skipped, partial, quiet }; when complete, the next review starts at until.",
    input: v.object({
      since: v.optional(v.pipe(v.string(), v.description("where the last review ended: ISO 8601, or 2h / 1d ago"))),
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
    }),
    annotations: READ,
    online: (adapter, args, { guard }) =>
      servicesFor(onlineDeps(messenger, adapter, guard)).inbox.review({
        since: args.since === undefined ? reviewStart() : momentOf(args.since, "since"),
        ...(args.chat === undefined ? {} : { chat: args.chat }),
        ...(args.all ? { all: true } : {}),
        ...(args.unanswered === undefined ? {} : { unansweredAfterHours: args.unanswered }),
      }),
  }),
})
