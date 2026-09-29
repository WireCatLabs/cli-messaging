import * as v from "valibot"
import { CHAT_SCAN, checkedFilter, filteredChats } from "../../cli/messenger/chats-command.js"
import type { Messenger } from "../../cli/messenger/context.js"
import { type AnyTool, chatOf, envelope, limit, page, paging, READ, tool } from "../tool.js"

export const chatsTools = (messenger: Messenger): Record<string, AnyTool> => {
  const chat = chatOf(messenger)
  return {
    chats_list: tool({
      title: "List chats",
      description:
        "Chats the owner is in, most recent first. Use it to find a chat's id before reading or sending. " +
        `With search, kind or unread, only the newest ${CHAT_SCAN} chats are searched, and partial says there were ` +
        "older ones. Returns { items, page, limit, hasMore, partial? }.",
      input: v.object({
        search: v.optional(v.pipe(v.string(), v.minLength(3), v.description("only chats whose name contains this"))),
        kind: v.optional(v.picklist(["dialog", "group", "channel", "saved"])),
        unread: v.optional(v.pipe(v.boolean(), v.description("only chats with unread messages"))),
        limit,
        page,
      }),
      annotations: READ,
      online: async (adapter, { search, kind, unread, ...rest }, defaults) => {
        const { size, number, window } = paging(rest, defaults)
        if (search === undefined && kind === undefined && !unread) {
          return envelope(await adapter.chats(window), number, size)
        }
        const found = await filteredChats({ adapter }, checkedFilter({ search, kind, unread }), window)
        return { ...envelope(found, number, size), ...(found.partial ? { partial: true } : {}) }
      },
    }),

    chats_show: tool({
      title: "Show a chat",
      description: "One chat: its kind, unread count, last message time and who is in it.",
      input: v.object({ chat }),
      annotations: READ,
      online: (adapter, args) => adapter.chat(args.chat),
    }),
  }
}
