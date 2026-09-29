import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import { guardedSend } from "../../cli/messenger/messages-command.js"
import { sendTime } from "../../domain/send-time.js"
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
        `On outcome_unknown, retry with the send_id it returns and ${name} drops the duplicate; never with a new one. ` +
        `With \`at\`, ${name} sends it later and the answer carries scheduledFor; never retry a scheduled send — ` +
        "read messages_scheduled instead.",
      input: v.object({
        chat,
        text: v.pipe(v.string(), v.minLength(1)),
        reply_to: v.optional(v.pipe(message, v.description("the message this answers, in the same chat"))),
        send_id: v.optional(v.pipe(v.string(), v.minLength(1), v.description("from an earlier outcome_unknown"))),
        silent: v.optional(v.pipe(v.boolean(), v.description("deliver without a notification"))),
        no_preview: v.optional(v.pipe(v.boolean(), v.description("no preview card for a link in the text"))),
        markdown: v.optional(
          v.pipe(v.boolean(), v.description("read **bold**, _italic_, ~~struck~~ and `code`; \\ keeps a mark literal")),
        ),
        at: v.optional(
          v.pipe(
            v.string(),
            v.description("send it later: 2026-09-25T09:00 (the owner's local time), or 30m, 2h, 1d from now"),
          ),
        ),
      }),
      annotations: WRITE,
      _meta: APPROVE,
      permission: "send",
      online: async (adapter, args, { guard }) => {
        const at = args.at === undefined ? undefined : sendTime(args.at)
        const sent = await guardedSend(guard, adapter, {
          chat: args.chat,
          text: args.text,
          ...(args.send_id === undefined ? {} : { sendId: args.send_id }),
          ...(args.reply_to === undefined ? {} : { replyTo: args.reply_to }),
          ...(args.silent === true ? { silent: true } : {}),
          ...(args.no_preview === true ? { noPreview: true } : {}),
          ...(args.markdown === true ? { markdown: true } : {}),
          ...(at === undefined ? {} : { at }),
        })
        return { sendId: sent.sendId, message: sent.message, ...(at === undefined ? {} : { scheduledFor: at }) }
      },
    }),
  }
}
