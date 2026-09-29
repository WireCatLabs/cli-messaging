import { CliError } from "@leemour/cli-core"
import { Command } from "commander"
import type { Chat, ChatKind, Page } from "../../domain/models.js"
import { renderPage, window, withPaging } from "../paging.js"
import { type Messenger, messengerContext } from "./context.js"
import type { MessengerAdapter } from "./port.js"

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
