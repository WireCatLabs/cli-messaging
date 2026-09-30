import { CliError } from "@leemour/cli-core"
import { Command } from "commander"
import type { Chat, ChatKind, Page } from "../../domain/models.js"
import { renderPage, window, withPaging } from "../paging.js"
import { membersCommand } from "./chats-members-command.js"
import { markReadCommand } from "./chats-read-command.js"
import { type Messenger, messengerContext } from "./context.js"
import { momentOf } from "./inbox.js"
import { capability, type MessengerAdapter } from "./port.js"

/** How far back `chats events` looks without `--since`, as in max-cli. */
export const EVENTS_DAYS = 7

/** `chats events` and its tool alike; `only` keeps the events named, as typed. */
export const chatEventsOf = async (
  adapter: MessengerAdapter,
  chat: string,
  { since, only }: { since?: string; only?: string },
  flag = "--since",
) => {
  const from = since === undefined ? Date.now() - EVENTS_DAYS * 86_400_000 : momentOf(since, flag)
  const found = await capability(adapter, "chatEvents", "read who joined or left")(chat, { since: from })
  const wanted = only === undefined ? undefined : new Set(only.split(",").map((name) => name.trim()))
  return wanted ? { ...found, events: found.events.filter((one) => wanted.has(one.event)) } : found
}

/** A filtered list searches the newest this many: paging through every dialog hit FLOOD_WAIT (tg handoff §4.14). */
export const CHAT_SCAN = 200
const KINDS: ChatKind[] = ["dialog", "group", "channel", "saved"]

export interface ChatFilter {
  search?: string
  kind?: string
  unread?: boolean
}

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

const matches = ({ search, kind, unread }: ChatFilter) => {
  const needle = search?.toLocaleLowerCase()
  return (chat: Chat) =>
    (needle === undefined || (chat.title ?? "").toLocaleLowerCase().includes(needle)) &&
    (kind === undefined || chat.kind === kind) &&
    (!unread || (chat.unreadCount ?? 0) > 0)
}

/**
 * One page of the chats that pass `filter`, cut from the newest `CHAT_SCAN` — or from every stored
 * chat, `recorded`, offline. `partial` says there were older chats that were not searched.
 */
export const filteredChats = async (
  source: { adapter: MessengerAdapter } | { recorded: Page<Chat> },
  filter: ChatFilter,
  { limit, offset }: { limit?: number; offset: number },
): Promise<Page<Chat> & { partial: boolean }> => {
  const scanned = "recorded" in source ? source.recorded : await source.adapter.chats({ limit: CHAT_SCAN, offset: 0 })
  const found = scanned.items.filter(matches(filter))
  const end = limit === undefined ? found.length : offset + limit
  return { items: found.slice(offset, end), hasMore: found.length > end, partial: scanned.hasMore }
}

const filtering = ({ search, kind, unread }: ChatFilter) =>
  search !== undefined || kind !== undefined || unread === true

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
        const page = !filtering(filter)
          ? context.settings.offline
            ? await context.withStore((store, account) => store.chats(account, wanted))
            : await context.withMessenger((connection) => connection.chats(wanted))
          : context.settings.offline
            ? await filteredChats(
                { recorded: await context.withStore((store, account) => store.chats(account, { offset: 0 })) },
                filter,
                wanted,
              )
            : await context.withMessenger((adapter) => filteredChats({ adapter }, filter, wanted))
        if ("partial" in page && page.partial) {
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
      if (context.settings.offline) {
        throw new CliError(
          "validation_error",
          "`chats events` reads the chat's history; with `--offline` there is none",
        )
      }
      const found = await context.withMessenger((adapter) =>
        chatEventsOf(adapter, chat, { ...(since === undefined ? {} : { since }), ...(event ? { only: event } : {}) }),
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
      if (context.settings.offline) {
        throw new CliError("validation_error", "`chats inspect` asks the messenger about the link; not with --offline")
      }
      context.renderer.result(
        await context.withMessenger((adapter) => capability(adapter, "inspect", "read a link")(link)),
      )
    })

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

  chats.addCommand(membersCommand(messenger))
  chats.addCommand(markReadCommand(messenger))

  return chats
}
