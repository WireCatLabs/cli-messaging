import { CliError } from "@leemour/cli-core"
import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import { sendTime } from "../../domain/send-time.js"
import { readUpload } from "../../sends/upload.js"
import { onlineDeps, servicesFor } from "../../services/index.js"
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
        "Send one message as the owner — text, or a file or photo from the owner's machine with the text as its " +
        "caption. Only when the owner asked for this exact message to this exact chat. Hidden files and folders, " +
        `~/.ssh and ${messenger.app.command}'s own folders are refused, with no way around it here. ` +
        "A name that matches several chats is refused with the candidates — pick an id, never guess. " +
        `On outcome_unknown, retry with the send_id it returns and ${name} drops the duplicate; never with a new one. ` +
        `With \`at\`, ${name} sends it later and the answer carries scheduledFor; never retry a scheduled send — ` +
        "read messages_scheduled instead.",
      input: v.object({
        chat,
        text: v.optional(v.pipe(v.string(), v.description("the message, or the caption of a file or photo"))),
        file: v.optional(
          v.pipe(v.string(), v.minLength(1), v.description("a path on the owner's machine to attach as a file")),
        ),
        photo: v.optional(
          v.pipe(v.string(), v.minLength(1), v.description("a .jpg, .png or .webp to attach as a photo")),
        ),
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
      online: async (adapter, args, { guard, env }) => {
        const at = args.at === undefined ? undefined : sendTime(args.at)
        // Never anyFile here: a path an agent was talked into is how a key would leave the machine.
        const read = { app: messenger.app, env }
        const attachments = [
          ...(args.photo === undefined ? [] : [await readUpload("photo", args.photo, read)]),
          ...(args.file === undefined ? [] : [await readUpload("file", args.file, read)]),
        ]
        if ((args.text ?? "").trim() === "" && attachments.length === 0) {
          throw new CliError("validation_error", "nothing to send — give text, a file or a photo")
        }
        const sent = await servicesFor(onlineDeps(messenger, adapter, guard)).messages.send({
          chat: args.chat,
          text: args.text ?? "",
          ...(attachments.length === 0 ? {} : { attachments }),
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
