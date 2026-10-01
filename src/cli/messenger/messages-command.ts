import { CliError } from "@leemour/cli-core"
import { annotate } from "@leemour/cli-core/commands"
import { Command } from "commander"
import { isLocator, parseLocator } from "../../domain/locator.js"
import { sendTime } from "../../domain/send-time.js"
import { renderMessages } from "../../render/messages.js"
import { readAttachments } from "../../sends/upload.js"
import { modelWith } from "../../speech/hearing.js"
import { listed, positiveCount } from "../paging.js"
import { afterOf, oneDirection } from "./after.js"
import { type Messenger, messengerContext } from "./context.js"
import { downloadSubcommand } from "./download-command.js"
import {
  heardItems,
  hearForCommand,
  hearingFields,
  MODEL_OPTION,
  spokenItems,
  TRANSCRIBE_OPTION,
} from "./hearing-command.js"
import { deleteCommand } from "./messages-delete-command.js"
import { editCommand } from "./messages-edit-command.js"
import { forwardCommand } from "./messages-forward-command.js"
import { pinCommand, unpinCommand } from "./messages-pin-command.js"
import { scheduledCommand } from "./messages-scheduled-command.js"
import { readAll } from "./stdin.js"
import { transcribeSubcommand } from "./transcribe-command.js"

/** `messages`: reading, and sending through the guard. A CLI may add its own subcommands. */
export const messagesCommand = (messenger: Messenger): Command => {
  const messages = new Command("messages").description("read and send messages")

  messages
    .command("list")
    .description("a chat's messages, oldest to newest")
    .argument("<chat>", messenger.chatArgument)
    .option("--limit <n>", "how many", positiveCount("--limit"))
    .option("--before <id>", "only messages older than this message id")
    .option("--after <id-or-time>", "only messages newer than this message id, ISO 8601 time, or 2h / 1d ago")
    .option(...TRANSCRIBE_OPTION)
    .option(...MODEL_OPTION)
    .option("--mark-read", "also mark the chat read up to the newest message shown; the other person sees it")
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      const { before, after, transcribe, model, markRead } = this.opts<{
        before?: string
        after?: string
        transcribe?: boolean
        model?: string
        markRead?: boolean
      }>()
      oneDirection(before, after)
      const hearWith = modelWith(transcribe, model)
      if (markRead && context.settings.offline) {
        throw new CliError("validation_error", "--mark-read tells the messenger; not with --offline")
      }
      const { limit } = context.settings
      const page = await context.withServices((services) =>
        services.messages.list(chat, {
          limit,
          ...(before === undefined ? {} : { before }),
          ...(after === undefined ? {} : { after: afterOf(after) }),
        }),
      )
      const hearing = await hearForCommand(context, messenger, page.items, transcribe === true, hearWith)
      const newest = page.items.at(-1)
      const marked =
        markRead && newest
          ? await context.withServices((services) => services.chats.markRead({ chat, until: newest.id }))
          : undefined
      if (marked) context.renderer.note(`marked read up to ${marked.until}`)
      const next = (items: typeof page.items) =>
        after === undefined ? `older messages: --before ${items[0]?.id}` : `newer messages: --after ${items.at(-1)?.id}`
      if (context.format === "pretty") {
        // Straight to stdout: the pretty renderer keeps every string to one line, and a feed is many.
        context.streams.data(
          renderMessages(spokenItems(page.items, hearing), {
            color: context.color,
            verbosity: context.settings.detail,
            senderColors: context.settings.senderColors,
            profile: context.profile,
            provider: messenger.provider,
            locale: messenger.app.locale,
          }),
        )
        if (page.hasMore) context.renderer.note(next(page.items))
        return
      }
      if (context.format === "jsonl") {
        context.renderer.stream(heardItems(page.items, hearing))
        if (page.hasMore) context.renderer.note(next(page.items))
        return
      }
      context.renderer.result({
        items: heardItems(page.items, hearing),
        page: 1,
        limit,
        hasMore: page.hasMore,
        ...hearingFields(hearing, transcribe === true),
        ...(marked ? { markedRead: { operationId: marked.operationId, until: marked.until } } : {}),
      })
    })

  const readWindow = async (command: Command, chat: string, message: string | undefined, window: Window) => {
    const context = messengerContext(command, messenger)
    const target = targetOf(messenger, chat, message)
    const found = await context.withServices((services) =>
      services.messages.around(target.chat, target.message, window),
    )
    if (context.format === "pretty") {
      context.streams.data(
        renderMessages(found, {
          color: context.color,
          verbosity: context.settings.detail,
          senderColors: context.settings.senderColors,
          profile: context.profile,
          provider: messenger.provider,
          locale: messenger.app.locale,
        }),
      )
    } else if (context.format === "jsonl") context.renderer.stream(found)
    else context.renderer.result(window.before === 0 && window.after === 0 ? found[0] : listed(found))
  }

  messages
    .command("search")
    .description("search the local store — what was read, fetched or kept by serve; never asks the messenger")
    .argument("<text...>", "every word must appear, as a word or the start of one: квартир finds квартира")
    .option("--chat <chat>", `only this chat: ${messenger.chatArgument}`)
    .option("--limit <n>", "how many", positiveCount("--limit"))
    .option("--regex", "the words are one regular expression, case-insensitive, tested against every stored text")
    .action(async function (this: Command, words: string[]) {
      const context = messengerContext(this, messenger)
      const { chat, regex } = this.opts<{ chat?: string; regex?: boolean }>()
      const { limit } = context.settings
      const pattern = regex ? patternOf(words.join(" ")) : undefined
      const page = await context.withServices((services) =>
        services.messages.search({
          ...(pattern ? { pattern } : { text: words.join(" ") }),
          limit,
          ...(chat === undefined ? {} : { chat }),
        }),
      )
      if (context.format === "pretty") {
        context.streams.data(
          page.items
            .map(
              (hit) =>
                `${hit.chatTitle ?? hit.chatId}  ${hit.locator}\n${renderMessages([hit], {
                  color: context.color,
                  verbosity: context.settings.detail,
                  senderColors: context.settings.senderColors,
                  profile: context.profile,
                  provider: messenger.provider,
                  locale: messenger.app.locale,
                })}`,
            )
            .join("\n"),
        )
        if (page.items.length === 0)
          context.renderer.note("nothing found — only what is in the local store is searched")
        return
      }
      if (context.format === "jsonl") context.renderer.stream(page.items)
      else context.renderer.result({ items: page.items, limit, hasMore: page.hasMore })
    })

  messages.addCommand(sendCommand(messenger))

  messages
    .command("show")
    .description("one message, by its chat and id or by its msg: locator")
    .argument("<chat>", `${messenger.chatArgument}; or a msg: locator, with no message id after it`)
    .argument("[message]", "the message id")
    .action(async function (this: Command, chat: string, message: string | undefined) {
      await readWindow(this, chat, message, { before: 0, after: 0 })
    })

  messages
    .command("context")
    .description("a message and what came either side of it, oldest first")
    .argument("<chat>", `${messenger.chatArgument}; or a msg: locator, with no message id after it`)
    .argument("[message]", "the message id")
    .option("--before <n>", "how many before it", count, 5)
    .option("--after <n>", "how many after it", count, 5)
    .action(async function (this: Command, chat: string, message: string | undefined) {
      const { before, after } = this.opts<Window>()
      await readWindow(this, chat, message, { before, after })
    })

  downloadSubcommand(messages, messenger)
  transcribeSubcommand(messages, messenger)

  messages.addCommand(editCommand(messenger))
  messages.addCommand(deleteCommand(messenger))
  messages.addCommand(forwardCommand(messenger))
  messages.addCommand(pinCommand(messenger))
  messages.addCommand(unpinCommand(messenger))
  messages.addCommand(scheduledCommand(messenger))
  return messages
}

/**
 * **Asked before it goes, told after, on every outcome** — the guard's journal is the only record
 * of what this profile tried to send, and it never holds the text.
 */
export const sendCommand = (messenger: Messenger): Command =>
  annotate(new Command("send"), { mutates: true })
    .description("send a text message; without [text], the text is read from stdin")
    .argument("<chat>", messenger.chatArgument)
    .argument("[text]", "the message")
    .option("--reply-to <message>", "answer this message, by its id in the same chat")
    .option("--send-id <id>", "repeat a send whose outcome was unknown, without risking a second copy")
    .option("--silent", "deliver without a notification")
    .option("--no-preview", "no preview card for a link in the text")
    .option("--md", "read **bold**, _italic_, ~~struck~~ and `code` in the text; \\ keeps a mark literal")
    .option("--file <file>", "attach a file; the text becomes its caption")
    .option("--photo <file>", "attach a .jpg, .png or .webp as a photo; the text becomes its caption")
    .option("--as-file", "send the --file as a file to download, a video included")
    .option("--voice <file>", "send an Ogg Opus file as a voice message, alone, with no text")
    .option("--allow-any-file", "send a file even from a hidden folder, ~/.ssh or this CLI's own folders")
    .option(
      "--at <time>",
      "let the messenger send it later, even with this machine off: 2026-09-25T09:00 (local time), or 30m, 2h, 1d from now",
    )
    .action(async function (this: Command, chat: string, text: string | undefined) {
      await sendText(this, messenger, chat, text)
    })

const sendText = async (command: Command, messenger: Messenger, chat: string, text: string | undefined) => {
  const context = messengerContext(command, messenger)
  const {
    replyTo: typedReplyTo,
    sendId,
    silent,
    preview,
    md: markdown,
    at,
    file,
    photo,
    voice,
    asFile,
    allowAnyFile,
  } = command.opts<{
    replyTo?: string
    sendId?: string
    silent?: boolean
    preview?: boolean
    md?: boolean
    at?: string
    file?: string
    photo?: string
    voice?: string
    asFile?: boolean
    allowAnyFile?: boolean
  }>()
  const scheduledFor = at === undefined ? undefined : sendTime(at)
  const replyTo = typedReplyTo?.trim()
  if (replyTo === "") throw new CliError("validation_error", "--reply-to needs the id of the message to answer")
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
      ...(silent === true ? { silent } : {}),
      ...(preview === false ? { noPreview: true } : {}),
      ...(markdown === true ? { markdown } : {}),
      ...(scheduledFor === undefined ? {} : { at: scheduledFor }),
      ...(attachments.length > 0 ? { attachments } : {}),
    }),
  )
  if (scheduledFor !== undefined) {
    context.renderer.note(`scheduled for ${scheduledFor} — it gets a new id when it is sent`)
    context.renderer.result({ sendId: sent.sendId, operationId: sent.operationId, message: sent.message, scheduledFor })
  } else context.renderer.result({ sendId: sent.sendId, operationId: sent.operationId, message: sent.message })
}

type Window = { before: number; after: number }

const count = (value: string): number => {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) throw new CliError("validation_error", `"${value}" is not a count`)
  return parsed
}

/** A chat and a message id, or one locator naming both — which must be this messenger's. */
const targetOf = (messenger: Messenger, chat: string, message: string | undefined) => {
  if (isLocator(chat)) {
    if (message !== undefined) throw new CliError("validation_error", "a locator already names the message")
    const locator = parseLocator(chat)
    if (locator.provider !== messenger.provider) {
      throw new CliError("validation_error", `that locator is a ${locator.provider} message, not ${messenger.provider}`)
    }
    return { chat: locator.chat, message: locator.message }
  }
  if (message === undefined) throw new CliError("validation_error", "which message? give its id after the chat")
  return { chat, message: message.trim() }
}

const patternOf = (source: string): RegExp => {
  try {
    return new RegExp(source, "iu")
  } catch (error) {
    throw new CliError("validation_error", `not a regular expression: ${(error as Error).message}`)
  }
}
