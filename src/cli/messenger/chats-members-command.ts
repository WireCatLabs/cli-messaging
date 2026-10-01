import { annotate } from "@leemour/cli-core/commands"
import { Command } from "commander"
import { renderPage, window, withPaging } from "../paging.js"
import { type Messenger, messengerContext } from "./context.js"

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
      const page = await context.withServices((services) => services.chats.members(chat, wanted))
      renderPage(context, page)
    }),
  )

  const add = annotate(new Command("add"), { mutates: true })
    .description("add people; they are told")
    .argument("<chat>", messenger.chatArgument)
    .argument("<person...>", "an id, or part of a name")
  if (messenger.addsWithHistory !== false) {
    add.option("--history", "the people added also see the messages from before they came")
  }
  members.addCommand(
    add.action(async function (this: Command, chat: string, people: string[]) {
      const context = messengerContext(this, messenger)
      const history = this.opts<{ history?: boolean }>().history === true
      context.renderer.result(
        await context.withServices((services) => services.admin.addMembers(chat, people, history ? { history } : {})),
      )
    }),
  )

  members.addCommand(
    annotate(new Command("remove"), { mutates: true })
      .description("remove people; their messages stay")
      .argument("<chat>", messenger.chatArgument)
      .argument("<person...>", "an id, or part of a name")
      .action(async function (this: Command, chat: string, people: string[]) {
        const context = messengerContext(this, messenger)
        context.renderer.result(await context.withServices((services) => services.admin.removeMembers(chat, people)))
      }),
  )

  return members
}
