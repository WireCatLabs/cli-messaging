import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import { capability } from "../../cli/messenger/port.js"
import { type AnyTool, chatOf, envelope, limit, page, paging, READ, tool } from "../tool.js"

export const topicsTools = (messenger: Messenger): Record<string, AnyTool> => ({
  topics_list: tool({
    title: "A forum group's topics",
    description:
      "The topics of a forum group, newest activity first: { id, title, closed, pinned, unreadCount, " +
      "lastMessageAt, createdAt }. A message in a topic carries its id as threadId. `search` matches titles. " +
      "Returns { items, page, limit, hasMore }.",
    input: v.object({
      chat: chatOf(messenger),
      search: v.optional(v.pipe(v.string(), v.minLength(1), v.description("words from the topic's title"))),
      limit,
      page,
    }),
    annotations: READ,
    online: async (adapter, { chat, search, ...rest }, defaults) => {
      const { size, number, window } = paging(rest, defaults)
      const found = await capability(
        adapter,
        "topics",
        "list forum topics",
      )(chat, {
        ...window,
        ...(search === undefined ? {} : { search }),
      })
      return envelope(found, number, size)
    },
  }),
})
