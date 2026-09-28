import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import { type AnyTool, chatOf, envelope, limit, page, paging, READ, tool } from "../tool.js"

export const chatsTools = (messenger: Messenger): Record<string, AnyTool> => {
  const chat = chatOf(messenger)
  return {
    chats_list: tool({
      title: "List chats",
      description:
        "Chats the owner is in, most recent first. Use it to find a chat's id before reading or sending. " +
        "Returns { items, page, limit, hasMore }.",
      input: v.object({ limit, page }),
      annotations: READ,
      online: async (adapter, args, defaults) => {
        const { size, number, window } = paging(args, defaults)
        return envelope(await adapter.chats(window), number, size)
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
