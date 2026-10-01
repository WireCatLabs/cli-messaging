import { annotate } from "@leemour/cli-core/commands"
import { Command } from "commander"
import { type Messenger, messengerContext } from "./context.js"

/** `chats create`, `join` and `leave`: the help text is max-cli's, the one both tools say (standard, help rule 2). */
export const groupCommands = (messenger: Messenger): Command[] => [
  annotate(new Command("create"), { mutates: true })
    .description("create a group or a channel; the people added are told")
    .argument("<title>", "the group's name")
    .argument("[person...]", "people to add: an id, or part of a name")
    .option("--channel", "a private channel instead of a group; people join it by its link")
    .action(async function (this: Command, title: string, people: string[]) {
      const context = messengerContext(this, messenger)
      const { channel } = this.opts<{ channel?: boolean }>()
      context.renderer.result(
        await context.withServices((services) => services.admin.create({ title, people, channel: channel === true })),
      )
    }),

  annotate(new Command("join"), { mutates: true })
    .description("join a group or channel by its link; the others in it see that you joined")
    .argument("<link>", `an invite link, or a public one`)
    .action(async function (this: Command, link: string) {
      const context = messengerContext(this, messenger)
      context.renderer.result(await context.withServices((services) => services.admin.join(link)))
    }),

  annotate(new Command("leave"), { mutates: true })
    .description("leave a group or channel; the others in it see that you left")
    .argument("<chat>", messenger.chatArgument)
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      context.renderer.result(await context.withServices((services) => services.admin.leave(chat)))
    }),
]
