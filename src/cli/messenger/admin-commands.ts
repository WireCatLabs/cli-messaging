import { CliError } from "@leemour/cli-core"
import { annotate } from "@leemour/cli-core/commands"
import { Command } from "commander"
import { GROUP_SETTINGS, type GroupSettings } from "../../domain/models.js"
import { type Messenger, messengerContext } from "./context.js"

const SETTING_FLAGS: Record<keyof GroupSettings, [flag: string, help: string]> = {
  allCanPin: ["all-can-pin", "every member may pin messages"],
  onlyAdminsAdd: ["only-admins-add", "only admins may add members"],
  onlyAdminsCall: ["only-admins-call", "only admins may start a call"],
  onlyOwnerEditsInfo: ["only-owner-edits-info", "only the owner may change the name and photo"],
  membersSeeLink: ["members-see-link", "members may see the invite link"],
}

const settingsOf = (
  keys: readonly (keyof GroupSettings)[],
  options: Record<string, unknown>,
): Partial<GroupSettings> => {
  const changes: Partial<GroupSettings> = {}
  for (const key of keys) {
    const value = options[key]
    if (value === undefined) continue
    if (value !== "on" && value !== "off") {
      throw new CliError("validation_error", `--${SETTING_FLAGS[key][0]} takes on or off, not "${String(value)}"`)
    }
    changes[key] = value === "on"
  }
  return changes
}

const updateCommand = (messenger: Messenger): Command => {
  const keys = messenger.groupSettings ?? GROUP_SETTINGS
  const update = annotate(new Command("update"), { mutates: true })
    .description("rename a group or channel, change its description, or turn one of its settings on or off")
    .argument("<chat>", messenger.chatArgument)
    .option("--title <title>", "the new name")
    .option("--description <text>", "the new description")
  for (const key of keys) update.option(`--${SETTING_FLAGS[key][0]} <on|off>`, SETTING_FLAGS[key][1])
  return update.action(async function (this: Command, chat: string) {
    const context = messengerContext(this, messenger)
    const { title, description, ...rest } = this.opts<{ title?: string; description?: string }>()
    const settings = settingsOf(keys, rest)
    context.renderer.result(
      await context.withServices((services) =>
        services.admin.update(chat, {
          ...(title === undefined ? {} : { title }),
          ...(description === undefined ? {} : { description }),
          ...(Object.keys(settings).length > 0 ? { settings } : {}),
        }),
      ),
    )
  })
}

const linkCommand = (messenger: Messenger): Command => {
  const link = new Command("link").description("a group's invite link")
  link
    .command("show")
    .description("the invite link, if you may see it")
    .argument("<chat>", messenger.chatArgument)
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      context.renderer.result(await context.withServices((services) => services.admin.link(chat)))
    })
  link.addCommand(
    annotate(new Command("reset"), { mutates: true })
      .description("replace the invite link; the old one stops working")
      .argument("<chat>", messenger.chatArgument)
      .action(async function (this: Command, chat: string) {
        const context = messengerContext(this, messenger)
        context.renderer.result(await context.withServices((services) => services.admin.resetLink(chat)))
      }),
  )
  return link
}

/** `chats create`, `join`, `leave`, `update` and `link`: the help text is max-cli's, the one both tools say (standard, help rule 2). */
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

  updateCommand(messenger),
  linkCommand(messenger),
]
