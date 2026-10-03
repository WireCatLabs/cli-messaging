import { Command } from "commander"
import { CHAT_KINDS, CHAT_SCAN, type ChatFilter, checkedFilter, EVENTS_DAYS } from "../../services/chats.js"
import { momentOf } from "../../services/moment.js"
import { listed, renderPage, window, withPaging } from "../paging.js"
import { groupCommands } from "./admin-commands.js"
import { foldersCommand } from "./admin-folders-command.js"
import { moderateCommand, rulesCommand } from "./admin-moderation-command.js"
import { membersCommand } from "./chats-members-command.js"
import { markReadCommand } from "./chats-read-command.js"
import { type Messenger, messengerContext } from "./context.js"

export const chatsCommand = (messenger: Messenger): Command => {
  const chats = new Command("chats").description("the account's chats")

  chats.addCommand(
    withPaging(new Command("list").description("chats, newest first, archived ones included"))
      .option("--search <text>", "only chats whose name contains this; at least 3 characters")
      .option("--kind <kind>", `only chats of this kind: ${CHAT_KINDS.join(", ")}`)
      .option("--unread", "only chats with unread messages")
      .action(async function (this: Command) {
        const context = messengerContext(this, messenger)
        const filter = checkedFilter(this.opts<ChatFilter>())
        const wanted = window(context.settings)
        const page = await context.withServices((services) => services.chats.list(filter, wanted))
        if (page.partial) {
          context.renderer.note(`only the ${CHAT_SCAN} newest chats were searched; an older one may match too`)
        }
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
    .command("events")
    .description("who joined, left, was added or removed, and by whom — from the chat's service messages")
    .argument("<chat>", messenger.chatArgument)
    .option("--since-time <time>", `ISO 8601, or 2h / 1d ago; ${EVENTS_DAYS} days ago if not given`)
    .option("--type <names>", "only these, comma-separated: join, leave, add, remove, create, title, pin")
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      const { sinceTime: since, type } = this.opts<{ sinceTime?: string; type?: string }>()
      const found = await context.withServices((services) =>
        services.chats.events(chat, {
          ...(since === undefined ? {} : { since: momentOf(since, "--since-time") }),
          ...(type ? { only: type } : {}),
        }),
      )
      if (context.format === "jsonl") context.renderer.stream(found.events)
      else if (context.format !== "pretty") {
        const { events, more, ...rest } = found
        context.renderer.result({ ...listed(events), hasMore: more, ...rest })
      } else {
        context.renderer.stream(
          found.events.map((one) => ({
            time: one.timestamp,
            event: one.event,
            by: one.by.name ?? one.by.id,
            people: one.people.map((person) => person.name ?? person.id).join(", "),
          })),
        )
      }
      if (found.more) context.renderer.note("more history than one run reads — adjust --since-time to read more")
    })

  chats
    .command("inspect")
    .description("what an invite or public link leads to, without joining it")
    .argument("<link>", "an invite link or a public one")
    .action(async function (this: Command, link: string) {
      const context = messengerContext(this, messenger)
      context.renderer.result(await context.withServices((services) => services.chats.inspect(link)))
    })

  chats
    .command("show")
    .description("one chat: its kind, unread count, last message time and who is in it")
    .argument("<chat>", messenger.chatArgument)
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      const card = await context.withServices((services) => services.chats.show(chat))
      context.renderer.result(card)
      const { members, participantsCount } = card
      if (members && participantsCount !== null && members.length < participantsCount) {
        context.renderer.note(`only ${members.length} of ${participantsCount} members could be read`)
      }
    })

  chats.addCommand(membersCommand(messenger))
  chats.addCommand(markReadCommand(messenger))
  for (const command of groupCommands(messenger)) chats.addCommand(command)
  chats.addCommand(foldersCommand(messenger))
  chats.addCommand(rulesCommand(messenger))
  chats.addCommand(moderateCommand(messenger))

  return chats
}
