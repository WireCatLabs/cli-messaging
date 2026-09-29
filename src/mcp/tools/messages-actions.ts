import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import { guardedEdit } from "../../cli/messenger/messages-edit-command.js"
import { type AnyTool, APPROVE, chatOf, message, tool, WRITE } from "../tool.js"

/** What changes a message others already have, offered with `--allow-send`, each behind its own `allow` permission. */
export const messageActionTools = (messenger: Messenger): Record<string, AnyTool> => {
  const chat = chatOf(messenger)
  return {
    messages_edit: tool({
      title: "Edit a message",
      description:
        "Replace the text of one of the owner's own messages. Only when the owner asked for this exact change. " +
        "The other side may have read the old text already. Repeating the same edit changes nothing.",
      input: v.object({ chat, message, text: v.pipe(v.string(), v.minLength(1)) }),
      annotations: WRITE,
      _meta: APPROVE,
      permission: "edit",
      online: async (adapter, args, { guard }) => ({
        message: await guardedEdit(guard, adapter, { chat: args.chat, message: args.message, text: args.text }),
      }),
    }),
  }
}
