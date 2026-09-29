import * as v from "valibot"
import { guardedMarkRead } from "../../cli/messenger/chats-read-command.js"
import type { Messenger } from "../../cli/messenger/context.js"
import { type AnyTool, APPROVE, chatOf, message, tool, WRITE } from "../tool.js"

export const chatsReadTools = (messenger: Messenger): Record<string, AnyTool> => ({
  chats_read: tool({
    title: "Mark a chat read",
    description:
      "Mark a chat read up to a message, or up to its newest message. The other side sees that it was read. " +
      "Only when the owner asked for it.",
    input: v.object({ chat: chatOf(messenger), until: v.optional(message) }),
    annotations: WRITE,
    _meta: APPROVE,
    permission: "read",
    online: (adapter, args, { guard }) =>
      guardedMarkRead(guard, adapter, { chat: args.chat, ...(args.until === undefined ? {} : { until: args.until }) }),
  }),
})
