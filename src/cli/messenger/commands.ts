import { CliError } from "@leemour/cli-core"
import { annotate } from "@leemour/cli-core/commands"
import { Command } from "commander"
import { isLocator, parseLocator } from "../../domain/locator.js"
import type { Chat, Contact } from "../../domain/models.js"
import { renderMessages } from "../../render/messages.js"
import { pickChat } from "../../resolve.js"
import { newSendId } from "../../sends/send-id.js"
import type { AccountKey, MessageStore } from "../../store/store.js"
import { renderPage, window, withPaging } from "../paging.js"
import { type Messenger, messengerContext } from "./context.js"

export const accountCommand = (messenger: Messenger): Command =>
  new Command("account").description("the logged-in account").addCommand(
    new Command("show").description("who this profile is logged in as").action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      context.renderer.result(await context.withMessenger((connection) => connection.me()))
    }),
  )

export const chatsCommand = (messenger: Messenger): Command => {
  const chats = new Command("chats").description("the account's chats")

  chats.addCommand(
    withPaging(new Command("list").description("chats, newest first, archived ones included")).action(async function (
      this: Command,
    ) {
      const context = messengerContext(this, messenger)
      const wanted = window(context.settings)
      const page = context.settings.offline
        ? await context.withStore((store, account) => store.chats(account, wanted))
        : await context.withMessenger((connection) => connection.chats(wanted))
      renderPage(context, {
        ...page,
        items:
          context.format === "pretty"
            ? page.items.map(({ id, title, kind, unreadCount, lastMessageAt }) => ({
                id,
                title,
                kind,
                unreadCount,
                lastMessageAt,
              }))
            : page.items,
      })
    }),
  )

  chats
    .command("show")
    .description("one chat: its kind, unread count, last message time and who is in it")
    .argument("<chat>", messenger.chatArgument)
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      const card = await context.withMessenger((connection) => connection.chat(chat))
      context.renderer.result(card)
      const { members, participantsCount } = card
      if (members && participantsCount !== null && members.length < participantsCount) {
        context.renderer.note(`only ${members.length} of ${participantsCount} members could be read`)
      }
    })

  return chats
}

/** `messages`: reading, and sending through the guard. A CLI may add its own subcommands. */
export const messagesCommand = (messenger: Messenger): Command => {
  const messages = new Command("messages").description("read and send messages")

  messages
    .command("list")
    .description("a chat's messages, oldest to newest")
    .argument("<chat>", messenger.chatArgument)
    .option("--limit <n>", "how many", (value) => Number.parseInt(value, 10))
    .option("--before <id>", "only messages older than this message id")
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      const { before } = this.opts<{ before?: string }>()
      const { limit } = context.settings
      const wanted = { limit, ...(before === undefined ? {} : { before }) }
      const page = context.settings.offline
        ? await context.withStore((store, account) =>
            store.messages(account, storedChatId(messenger, chat, store, account), wanted),
          )
        : await context.withMessenger((connection) => connection.history(chat, wanted))
      if (context.format === "pretty") {
        // Straight to stdout: the pretty renderer keeps every string to one line, and a feed is many.
        context.streams.data(
          renderMessages(page.items, {
            color: context.color,
            verbosity: context.settings.detail,
            senderColors: context.settings.senderColors,
            profile: context.profile,
            provider: messenger.provider,
          }),
        )
        if (page.hasMore) context.renderer.note(`older messages: --before ${page.items[0]?.id}`)
        return
      }
      context.renderer.result({ items: page.items, limit, hasMore: page.hasMore })
    })

  const readWindow = async (command: Command, chat: string, message: string | undefined, window: Window) => {
    const context = messengerContext(command, messenger)
    const target = targetOf(messenger, chat, message)
    const found = context.settings.offline
      ? await context.withStore((store, account) =>
          store.around(account, storedChatId(messenger, target.chat, store, account), target.message, window),
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

  annotate(messages.command("send"), { mutates: true })
    .description("send a text message; without [text], the text is read from stdin")
    .argument("<chat>", messenger.chatArgument)
    .argument("[text]", "the message")
    .option("--send-id <id>", "repeat a send whose outcome was unknown, without risking a second copy")
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
  const { sendId } = command.opts<{ sendId?: string }>()
  const body = text ?? (await readAll(context.stdin))
  if (body.trim() === "") throw new CliError("validation_error", "nothing to send — give the text or pipe it in")
  const sent = await context.withMessenger(async (connection) => {
    const { guard } = context
    const { id: chatId } = await connection.resolve(chat)
    const attempt = {
      chatId,
      kind: "message" as const,
      sendId: sendId ?? newSendId(),
      length: body.length,
      ...(replyTo === undefined ? {} : { replyTo }),
    }
    try {
      guard.check(attempt)
    } catch (error) {
      guard.record({ ...attempt, outcome: "refused", errorCode: codeOf(error) })
      throw error
    }
    try {
      const done = await connection.send(chatId, body, {
        sendId: attempt.sendId,
        ...(replyTo === undefined ? {} : { replyTo }),
      })
      guard.record({ ...attempt, outcome: "sent", messageId: done.message.id })
      return done
    } catch (error) {
      const code = codeOf(error)
      guard.record({ ...attempt, outcome: code === "outcome_unknown" ? "outcome_unknown" : "failed", errorCode: code })
      throw error
    }
  })
  context.renderer.result({ sendId: sent.sendId, message: sent.message })
}

const codeOf = (error: unknown): string =>
  typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "unknown"

const readAll = async (input: NodeJS.ReadableStream & { isTTY?: boolean }): Promise<string> => {
  if (input.isTTY) return ""
  const chunks: Buffer[] = []
  for await (const chunk of input) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf8")
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

/** A chat as typed, found among the stored chats the way an adapter finds it among its own. */
const storedChatId = (messenger: Messenger, reference: string, store: MessageStore, account: AccountKey): string => {
  const trimmed = reference.trim()
  if (messenger.savedChatId && ["me", "self", "saved"].includes(trimmed.toLowerCase())) {
    return messenger.savedChatId(account)
  }
  if (/^-?\d+$/.test(trimmed)) return trimmed
  const chats = store.chats(account, {}).items
  if (trimmed.startsWith("@")) {
    const username = trimmed.slice(1).toLowerCase()
    const found = chats.find((one) => String(one.providerMetadata?.username ?? "").toLowerCase() === username)
    if (!found) throw new CliError("not_found", `no stored chat is ${trimmed}`)
    return found.id
  }
  return pickChat(trimmed, chats).id
}

/**
 * A contact is somebody this account has a one-to-one chat with — a query over the chat list, never
 * a flag somebody maintains (max-cli `NEED-105`). So the list works offline from the stored chats.
 */
export const contactsCommand = (messenger: Messenger): Command => {
  const contacts = new Command("contacts").description("people this account has a one-to-one chat with")

  contacts.addCommand(
    withPaging(new Command("list").description("people you have a one-to-one chat with"))
      .option("--order <recent|name>", "newest conversation first, or alphabetical", "recent")
      .option("--search <text>", "only people whose name or @username contains this")
      .action(async function (this: Command) {
        const { order, search } = this.opts<{ order: string; search?: string }>()
        if (order !== "recent" && order !== "name") {
          throw new CliError("validation_error", `--order is recent or name, not "${order}"`)
        }
        const context = messengerContext(this, messenger)
        const chats = context.settings.offline
          ? await context.withStore((store, account) => store.chats(account, {}).items)
          : await context.withMessenger(async (connection) => (await connection.chats({ offset: 0 })).items)
        const wanted = search?.trim().toLowerCase()
        const people = chats
          .filter((chat) => chat.kind === "dialog")
          .map(toContact)
          .filter(
            (person) =>
              !wanted || [person.name, person.username].some((field) => field?.toLowerCase().includes(wanted)),
          )
          .sort(order === "name" ? byName : byRecency)
        const { limit, offset } = window(context.settings)
        const end = limit === undefined ? people.length : offset + limit
        renderPage(context, { items: people.slice(offset, end), hasMore: people.length > end })
      }),
  )

  contacts
    .command("show")
    .description("one person and the chats you share with them")
    .argument("<person>", "their id, @username, or part of their name")
    .action(async function (this: Command, person: string) {
      const context = messengerContext(this, messenger)
      context.renderer.result(await context.withMessenger((connection) => connection.contact(person)))
    })

  return contacts
}

const toContact = (chat: Chat): Contact => ({
  id: chat.id,
  name: chat.title,
  username: typeof chat.providerMetadata?.username === "string" ? chat.providerMetadata.username : null,
  description: null,
  lastMessagedAt: chat.lastMessageAt,
})

const byRecency = (a: Contact, b: Contact) => (b.lastMessagedAt ?? "").localeCompare(a.lastMessagedAt ?? "")
const byName = (a: Contact, b: Contact) => (a.name ?? "").localeCompare(b.name ?? "")
