import { CliError } from "@leemour/cli-core"
import { annotate } from "@leemour/cli-core/commands"
import { Command } from "commander"
import { sendTime } from "../../domain/send-time.js"
import { readAttachments } from "../../sends/upload.js"
import { type Messenger, messengerContext } from "./context.js"
import { readAll } from "./stdin.js"
import { threadIdOf } from "./thread.js"

/**
 * **Asked before it goes, told after, on every outcome** — the guard's journal is the only record
 * of what this profile tried to send, and it never holds the text.
 */
export const sendCommand = (messenger: Messenger): Command =>
  annotate(new Command("send"), { mutates: true })
    .description("send a text message; without [text], the text is read from stdin")
    .argument("<chat>", messenger.chatArgument)
    .argument("[text]", "the message")
    .option("--topic <id>", "send to this forum topic; unsupported by messengers without topics")
    .option("--reply-to <message>", "answer this message, by its id in the same chat")
    .option("--send-as <id>", "post as one of the identities `chats send-as` lists; text only")
    .option("--send-id <id>", "repeat a send whose outcome was unknown, without risking a second copy")
    .option("--silent", "deliver without a notification")
    .option("--no-preview", "no preview card for a link in the text")
    .option("--md", "read this messenger's Markdown; see its formatting guide for supported syntax")
    .option("--file <file>", "attach a file; the text becomes its caption")
    .option("--photo <file>", "attach a .jpg, .png or .webp as a photo; the text becomes its caption")
    .option("--as-file", "send the --file as a file to download, a video included")
    .option("--spoiler", "hide the --photo or video behind a spoiler until tapped")
    .option("--caption-above", "show the text above the --photo or --file, not below it")
    .option("--voice <file>", "send an Ogg Opus file as a voice message, alone, with no text")
    .option("--allow-any-file", "send a file even from a hidden folder, ~/.ssh or this CLI's own folders")
    .option(
      "--at-time <time>",
      "let the messenger send it later, even with this machine off: 2026-09-25T09:00 (local time), or 30m, 2h, 1d from now",
    )
    .action(async function (this: Command, chat: string, text: string | undefined) {
      await sendText(this, messenger, chat, text)
    })

const sendText = async (command: Command, messenger: Messenger, chat: string, text: string | undefined) => {
  const context = messengerContext(command, messenger)
  const {
    topic,
    replyTo: typedReplyTo,
    sendAs: typedSendAs,
    sendId,
    silent,
    preview,
    md: markdown,
    atTime: at,
    file,
    photo,
    voice,
    asFile,
    allowAnyFile,
    spoiler,
    captionAbove,
  } = command.opts<{
    topic?: string
    replyTo?: string
    sendAs?: string
    sendId?: string
    silent?: boolean
    preview?: boolean
    md?: boolean
    atTime?: string
    file?: string
    photo?: string
    voice?: string
    asFile?: boolean
    allowAnyFile?: boolean
    spoiler?: boolean
    captionAbove?: boolean
  }>()
  const threadId = threadIdOf(topic)
  const scheduledFor = at === undefined ? undefined : sendTime(at)
  const replyTo = typedReplyTo?.trim()
  if (replyTo === "") throw new CliError("validation_error", "--reply-to needs the id of the message to answer")
  const sendAs = typedSendAs?.trim()
  if (sendAs === "") throw new CliError("validation_error", "--send-as needs an id from `chats send-as`")
  const read = { app: messenger.app, env: context.env, anyFile: allowAnyFile === true }
  const attachments = await readAttachments(
    {
      ...(photo === undefined ? {} : { photo }),
      ...(file === undefined ? {} : { file }),
      ...(voice === undefined ? {} : { voice }),
      ...(text === undefined ? {} : { text }),
      asFile: asFile === true,
    },
    read,
  )
  const body = text ?? (attachments.length > 0 ? "" : await readAll(context.stdin))
  if (body.trim() === "" && attachments.length === 0) {
    throw new CliError("validation_error", "nothing to send — give the text or pipe it in")
  }
  const sent = await context.withServices((services) =>
    services.messages.send({
      chat,
      text: body,
      ...(sendId === undefined ? {} : { sendId }),
      ...(replyTo === undefined ? {} : { replyTo }),
      ...(threadId === undefined ? {} : { threadId }),
      ...(sendAs === undefined ? {} : { sendAs }),
      ...(silent === true ? { silent } : {}),
      ...(preview === false ? { noPreview: true } : {}),
      ...(markdown === true ? { markdown } : {}),
      ...(scheduledFor === undefined ? {} : { at: scheduledFor }),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(spoiler === true ? { spoiler } : {}),
      ...(captionAbove === true ? { captionAbove } : {}),
    }),
  )
  if (scheduledFor !== undefined) {
    context.renderer.note(`scheduled for ${scheduledFor} — it gets a new id when it is sent`)
    context.renderer.result({ sendId: sent.sendId, operationId: sent.operationId, message: sent.message, scheduledFor })
  } else context.renderer.result({ sendId: sent.sendId, operationId: sent.operationId, message: sent.message })
}
