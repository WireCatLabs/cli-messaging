import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import { momentOf, newIn, unreadIn } from "../../cli/messenger/inbox.js"
import { type AnyTool, READ, tool } from "../tool.js"

/** Per chat: unread across many chats at a hundred each would outgrow what a client keeps of one answer. */
const INBOX_LIMIT = 20

export const inboxTools = (messenger: Messenger): Record<string, AnyTool> => {
  return {
    inbox: tool({
      title: "What is new",
      description:
        "Other people's messages waiting for the owner, grouped by chat, in one call: the unread ones, or with " +
        `\`since\` everything after that point. Marks nothing read and moves no saved point — the owner's ` +
        `\`${messenger.app.command} inbox --new\` is unaffected. Muted and archived chats are left out unless they ` +
        "mention the owner or reply to them, or `all` is set. Returns { mode, chats: [{ id, title, messages, more }], " +
        "skipped, partial, quiet }, where quiet counts the chats left out.",
      input: v.object({
        since: v.optional(v.pipe(v.string(), v.description("an ISO 8601 time, or 2h / 1d ago"))),
        all: v.optional(v.pipe(v.boolean(), v.description("muted and archived chats too"))),
        limit: v.optional(
          v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100), v.description("at most this many per chat")),
        ),
      }),
      annotations: READ,
      online: (adapter, args) => {
        const limit = args.limit ?? INBOX_LIMIT
        return args.since === undefined
          ? unreadIn(adapter, { limit, all: args.all })
          : newIn(adapter, { since: momentOf(args.since, "since"), limit, all: args.all })
      },
    }),
  }
}
