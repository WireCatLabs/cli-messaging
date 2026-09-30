import { CliError } from "@leemour/cli-core"
import { Command } from "commander"
import type { ChatKind } from "../../domain/models.js"
import { CHAT_SCAN, type ChatFilter, EVENTS_DAYS } from "../../services/index.js"
import { renderPage, window, withPaging } from "../paging.js"
import { membersCommand } from "./chats-members-command.js"
import { markReadCommand } from "./chats-read-command.js"
import { type Messenger, messengerContext } from "./context.js"
import { momentOf } from "./inbox.js"

const KINDS: ChatKind[] = ["dialog", "group", "channel", "saved"]

/** Refuses a filter that would match nothing useful, before anything is asked. */
export const checkedFilter = ({ search, kind, unread }: ChatFilter): ChatFilter => {
  if (search !== undefined && search.trim().length < 3) {
    throw new CliError("validation_error", `--search takes at least 3 characters, got "${search}"`)
  }
  if (kind !== undefined && !KINDS.includes(kind as ChatKind)) {
    throw new CliError("validation_error", `--kind is one of ${KINDS.join(", ")} — not "${kind}"`)
  }
  return {
    ...(search === undefined ? {} : { search: search.trim() }),
    ...(kind ? { kind } : {}),
    ...(unread ? { unread } : {}),
  }
}

export const chatsCommand = (messenger: Messenger): Command => {
  const chats = new Command("chats").description("the account's chats")

  chats.addCommand(
    withPaging(new Command("list").description("chats, newest first, archived ones included"))
      .option("--search <text>", "only chats whose name contains this; at least 3 characters")
      .option("--kind <kind>", `only chats of this kind: ${KINDS.join(", ")}`)
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
    .option("--since <time>", `ISO 8601, or 2h / 1d ago; ${EVENTS_DAYS} days ago if not given`)
    .option("--event <names>", "only these, comma-separated: join, leave, add, remove, create, title, pin")
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      const { since, event } = this.opts<{ since?: string; event?: string }>()
      const found = await context.withServices((services) =>
        services.chats.events(chat, {
          ...(since === undefined ? {} : { since: momentOf(since, "--since") }),
          ...(event ? { only: event } : {}),
        }),
      )
      if (context.format === "jsonl") context.renderer.stream(found.events)
      else if (context.format !== "pretty") context.renderer.result(found)
      else {
        context.renderer.stream(
          found.events.map((one) => ({
            time: one.timestamp,
            event: one.event,
            by: one.by.name ?? one.by.id,
            people: one.people.map((person) => person.name ?? person.id).join(", "),
          })),
        )
      }
      if (found.more) context.renderer.note("more history than one run reads; the newest are here — narrow --since")
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

  return chats
}
