import { Command } from "commander"
import { renderPage, window, withPaging } from "../paging.js"
import { type Messenger, messengerContext } from "./context.js"

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
