import { CliError } from "@leemour/cli-core"
import { annotate } from "@leemour/cli-core/commands"
import { Command } from "commander"
import { isLocator, parseLocator } from "../../domain/locator.js"
import { parseMarkdown } from "../../domain/markdown.js"
import { sendTime } from "../../domain/send-time.js"
import { renderMessages } from "../../render/messages.js"
import { pickChat } from "../../resolve.js"
import type { SendGuard } from "../../sends/guard.js"
import { newSendId } from "../../sends/send-id.js"
import { readUpload, type Upload } from "../../sends/upload.js"
import type { AccountKey, MessageStore } from "../../store/store.js"
import { afterOf, oneDirection } from "./after.js"
import { type Messenger, messengerContext } from "./context.js"
import { downloadSubcommand } from "./download-command.js"
import { heardItems, hearForCommand, hearingFields, spokenItems, TRANSCRIBE_OPTION } from "./hearing-command.js"
import { editCommand } from "./messages-edit-command.js"
import { forwardCommand } from "./messages-forward-command.js"
import { pinCommand, unpinCommand } from "./messages-pin-command.js"
import { scheduledCommand } from "./messages-scheduled-command.js"
import { capability, type MessengerAdapter, type Sent } from "./port.js"
import { readAll } from "./stdin.js"
import { transcribeSubcommand } from "./transcribe-command.js"

/** `messages`: reading, and sending through the guard. A CLI may add its own subcommands. */
export const messagesCommand = (messenger: Messenger): Command => {
  const messages = new Command("messages").description("read and send messages")

  messages
    .command("list")
    .description("a chat's messages, oldest to newest")
    .argument("<chat>", messenger.chatArgument)
    .option("--limit <n>", "how many", (value) => Number.parseInt(value, 10))
    .option("--before <id>", "only messages older than this message id")
    .option("--after <id-or-time>", "only messages newer than this message id, ISO 8601 time, or 2h / 1d ago")
    .option(...TRANSCRIBE_OPTION)
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      const { before, after, transcribe } = this.opts<{ before?: string; after?: string; transcribe?: boolean }>()
      oneDirection(before, after)
      const { limit } = context.settings
      const wanted = { limit, ...(before === undefined ? {} : { before }) }
      if (after !== undefined && context.settings.offline) {
        throw new CliError("validation_error", "--after reads from the messenger; the store pages only backwards")
      }
      const page =
        after !== undefined
          ? await context.withMessenger((connection) =>
              capability(
                connection,
                "historyAfter",
                "read forward from a message",
              )(chat, { limit, after: afterOf(after) }),
            )
          : context.settings.offline
            ? await context.withStore(async (store, account) =>
                store.messages(account, await storedChatId(messenger, chat, store, account), wanted),
              )
            : await context.withMessenger((connection) => connection.history(chat, wanted))
      const hearing = await hearForCommand(context, messenger, page.items, transcribe === true)
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
        limit,
        hasMore: page.hasMore,
        ...hearingFields(hearing, transcribe === true),
      })
    })

  const readWindow = async (command: Command, chat: string, message: string | undefined, window: Window) => {
    const context = messengerContext(command, messenger)
    const target = targetOf(messenger, chat, message)
    const found = context.settings.offline
      ? await context.withStore(async (store, account) =>
          store.around(account, await storedChatId(messenger, target.chat, store, account), target.message, window),
        )
      : await context.withMessenger((connection) => connection.around(target.chat, target.message, window))
    if (context.format === "pretty") {
      context.streams.data(
        renderMessages(found, {
          color: context.color,
          verbosity: context.settings.detail,
          senderColors: context.settings.senderColors,
          profile: context.profile,
          provider: messenger.provider,
        }),
      )
    } else if (context.format === "jsonl") context.renderer.stream(found)
    else context.renderer.result(window.before === 0 && window.after === 0 ? found[0] : { items: found })
  }

  messages
    .command("search")
    .description("search the local store — what was read, backfilled or kept by serve; never asks the messenger")
    .argument("<words...>", "every word must appear, as a word or the start of one: квартир finds квартира")
    .option("--chat <chat>", `only this chat: ${messenger.chatArgument}`)
    .option("--limit <n>", "how many", (value) => Number.parseInt(value, 10))
    .option("--regex", "the words are one regular expression, case-insensitive, tested against every stored text")
    .action(async function (this: Command, words: string[]) {
      const context = messengerContext(this, messenger)
      const { chat, regex } = this.opts<{ chat?: string; regex?: boolean }>()
      const { limit } = context.settings
      const pattern = regex ? patternOf(words.join(" ")) : undefined
      const page = await context.withStore(async (store, account) =>
        store.find({
          ...(pattern ? { pattern } : { text: words.join(" ") }),
          account,
          limit,
          ...(chat === undefined ? {} : { chatId: await storedChatId(messenger, chat, store, account) }),
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

  annotate(messages.command("send"), { mutates: true })
    .description("send a text message; without [text], the text is read from stdin")
    .argument("<chat>", messenger.chatArgument)
    .argument("[text]", "the message")
    .option("--send-id <id>", "repeat a send whose outcome was unknown, without risking a second copy")
    .option("--silent", "deliver without a notification")
    .option("--no-preview", "no preview card for a link in the text")
    .option("--md, --markdown", "read **bold**, _italic_, ~~struck~~ and `code` in the text; \\ keeps a mark literal")
    .option("--file <path>", "attach a file; the text becomes its caption")
    .option("--photo <path>", "attach a .jpg, .png or .webp as a photo; the text becomes its caption")
    .option("--allow-any-file", "send a file even from a hidden folder, ~/.ssh or this CLI's own folders")
    .option(
      "--at <time>",
      "let the messenger send it later, even with this machine off: 2026-09-25T09:00 (local time), or 30m, 2h, 1d from now",
    )
    .action(async function (this: Command, chat: string, text: string | undefined) {
      await sendText(this, messenger, chat, text, undefined)
    })

  annotate(messages.command("reply"), { mutates: true })
    .description("answer one message; without [text], the text is read from stdin")
    .argument("<chat>", `${messenger.chatArgument}; or a msg: locator, with no message id after it`)
    .argument("[message]", "the message id to answer")
    .argument("[text]", "the reply")
    .option("--send-id <id>", "repeat a reply whose outcome was unknown, without risking a second copy")
    .action(async function (this: Command, chat: string, message: string | undefined, text: string | undefined) {
      // With a locator the message is named already, so the second word is the text.
      const target = isLocator(chat) ? targetOf(messenger, chat, undefined) : targetOf(messenger, chat, message)
      await sendText(this, messenger, target.chat, isLocator(chat) ? message : text, target.message)
    })

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
const sendText = async (
  command: Command,
  messenger: Messenger,
  chat: string,
  text: string | undefined,
  replyTo: string | undefined,
) => {
  const context = messengerContext(command, messenger)
  const { sendId, silent, preview, markdown, at, file, photo, allowAnyFile } = command.opts<{
    sendId?: string
    silent?: boolean
    preview?: boolean
    markdown?: boolean
    at?: string
    file?: string
    photo?: string
    allowAnyFile?: boolean
  }>()
  const scheduledFor = at === undefined ? undefined : sendTime(at)
  const read = { app: messenger.app, env: context.env, anyFile: allowAnyFile === true }
  const attachments = [
    ...(photo === undefined ? [] : [await readUpload("photo", photo, read)]),
    ...(file === undefined ? [] : [await readUpload("file", file, read)]),
  ]
  const body = text ?? (attachments.length > 0 ? "" : await readAll(context.stdin))
  if (body.trim() === "" && attachments.length === 0) {
    throw new CliError("validation_error", "nothing to send — give the text or pipe it in")
  }
  const sent = await context.withMessenger((connection) =>
    guardedSend(context.guard, connection, {
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
    context.renderer.result({ sendId: sent.sendId, message: sent.message, scheduledFor })
  } else context.renderer.result({ sendId: sent.sendId, message: sent.message })
}

/** Resolve → check → send → record: one path for `messages send`, `reply` and the MCP send tool. */
export const guardedSend = async (
  guard: SendGuard,
  connection: MessengerAdapter,
  { chat, text: typed, sendId, replyTo, silent, noPreview, markdown, at, attachments = [] }: GuardedSend,
): Promise<Sent> => {
  if (at !== undefined && sendId !== undefined) {
    throw new CliError(
      "validation_error",
      "a scheduled send is never repeated: it would be scheduled twice — look in `messages scheduled` instead",
    )
  }
  const { text, markup } = markdown ? parseMarkdown(typed) : { text: typed, markup: [] }
  if (text.trim() === "" && attachments.length === 0) {
    throw new CliError("validation_error", "nothing to send — the marks leave no text")
  }
  const { id: chatId } = await connection.resolve(chat)
  const attempt = {
    chatId,
    kind: "message" as const,
    sendId: sendId ?? newSendId(),
    length: text.length,
    ...(replyTo === undefined ? {} : { replyTo }),
    ...(at === undefined ? {} : { scheduledFor: at }),
    ...(attachments.length === 0
      ? {}
      : { attachments: attachments.map(({ kind, bytes }) => ({ kind, bytes: bytes.byteLength })) }),
  }
  try {
    guard.check(attempt)
  } catch (error) {
    guard.record({ ...attempt, outcome: "refused", errorCode: codeOf(error) })
    throw error
  }
  try {
    const done = await connection.send(chatId, text, {
      sendId: attempt.sendId,
      ...(replyTo === undefined ? {} : { replyTo }),
      ...(silent ? { silent } : {}),
      ...(noPreview ? { noPreview } : {}),
      ...(markup.length > 0 ? { markup } : {}),
      ...(at === undefined ? {} : { at }),
      ...(attachments.length === 0 ? {} : { attachments }),
    })
    guard.record({ ...attempt, outcome: "sent", messageId: done.message.id })
    return done
  } catch (error) {
    const code = codeOf(error)
    guard.record({ ...attempt, outcome: code === "outcome_unknown" ? "outcome_unknown" : "failed", errorCode: code })
    if (at !== undefined && code === "outcome_unknown") {
      throw new CliError(
        "outcome_unknown",
        "no answer — the message may have been scheduled. Look in `messages scheduled` before anything else; " +
          "never send it again with --send-id",
        { scheduledFor: at },
      )
    }
    throw error
  }
}

interface GuardedSend {
  chat: string
  /** As typed: with `markdown`, the marks are taken out before it is sent or measured. */
  text: string
  sendId?: string
  replyTo?: string
  silent?: boolean
  noPreview?: boolean
  markdown?: boolean
  /** ISO time to send it at; refused together with `sendId`. */
  at?: string
  attachments?: Upload[]
}

const codeOf = (error: unknown): string =>
  typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "unknown"

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

/** A chat as typed, found among the stored chats the way an adapter finds it among its own. */
const patternOf = (source: string): RegExp => {
  try {
    return new RegExp(source, "iu")
  } catch (error) {
    throw new CliError("validation_error", `not a regular expression: ${(error as Error).message}`)
  }
}

export const storedChatId = async (
  messenger: Messenger,
  reference: string,
  store: MessageStore,
  account: AccountKey,
): Promise<string> => {
  const trimmed = reference.trim()
  if (messenger.savedChatId && ["me", "self", "saved"].includes(trimmed.toLowerCase())) {
    return messenger.savedChatId(account)
  }
  if (/^-?\d+$/.test(trimmed)) return trimmed
  const chats = (await store.chats(account, {})).items
  if (trimmed.startsWith("@")) {
    const username = trimmed.slice(1).toLowerCase()
    const found = chats.find((one) => String(one.providerMetadata?.username ?? "").toLowerCase() === username)
    if (!found) throw new CliError("not_found", `no stored chat is ${trimmed}`)
    return found.id
  }
  return pickChat(trimmed, chats).id
}
