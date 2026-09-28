import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import { guardedSend } from "../../cli/messenger/messages-command.js"
import { type AnyTool, APPROVE, chatOf, message, nameOf, tool, WRITE } from "../tool.js"

/**
 * Registered only with `--allow-send`, so a server started without it has no way to write at all —
 * not a refusal at call time, an absence from the list. Each goes through the same guard as its
 * command: read-only profile, `allow`, the recipient list, the hourly limit, the journal.
 */
export const messageSendTools = (messenger: Messenger): Record<string, AnyTool> => {
  const chat = chatOf(messenger)
  const name = nameOf(messenger)
  return {
    messages_send: tool({
      title: "Send a message",
      description:
        "Send one text message as the owner. Only when the owner asked for this exact text to this exact chat. " +
        "A name that matches several chats is refused with the candidates — pick an id, never guess. " +
        `On outcome_unknown, retry with the send_id it returns and ${name} drops the duplicate; never with a new one.`,
      input: v.object({
        chat,
        text: v.pipe(v.string(), v.minLength(1)),
        reply_to: v.optional(v.pipe(message, v.description("the message this answers, in the same chat"))),
        send_id: v.optional(v.pipe(v.string(), v.minLength(1), v.description("from an earlier outcome_unknown"))),
      }),
      annotations: WRITE,
      _meta: APPROVE,
      permission: "send",
      online: async (adapter, args, { guard }) => {
        const sent = await guardedSend(guard, adapter, {
          chat: args.chat,
          text: args.text,
          ...(args.send_id === undefined ? {} : { sendId: args.send_id }),
          ...(args.reply_to === undefined ? {} : { replyTo: args.reply_to }),
        })
        return { sendId: sent.sendId, message: sent.message }
      },
    }),
  }
}
