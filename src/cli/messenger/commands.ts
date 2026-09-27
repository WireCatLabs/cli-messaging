import { CliError } from "@leemour/cli-core"
import { Command } from "commander"
import { renderMessages } from "../../render/messages.js"
import { pickChat } from "../../resolve.js"
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

export const chatsCommand = (messenger: Messenger): Command =>
  new Command("chats").description("the account's chats").addCommand(
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

/** `messages` with `list`. A CLI adds its own subcommands — `send` — to what this returns. */
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

  return messages
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
