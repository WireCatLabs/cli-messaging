import { Command } from "commander"
import { renderPage, window, withPaging } from "../paging.js"
import { type Messenger, messengerContext } from "./context.js"
import { capability } from "./port.js"

/** `chats members …`; a subcommand that changes membership belongs here too. */
export const membersCommand = (messenger: Messenger): Command => {
  const members = new Command("members").description("who is in a group")

  members.addCommand(
    withPaging(
      new Command("list")
        .description("everyone in a group, a page at a time, with their role and when they were last seen")
        .argument("<chat>", messenger.chatArgument),
    ).action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      const wanted = window(context.settings)
      const page = await context.withMessenger((adapter) =>
        capability(adapter, "members", "list a group's members")(chat, wanted),
      )
      renderPage(context, page)
    }),
  )

  return members
}
