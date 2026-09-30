import { CliError } from "@leemour/cli-core"
import { capability } from "../cli/messenger/port.js"
import type { Chat, ChatCard, ChatEvents, GroupMember, Id, LinkTarget, Page } from "../domain/models.js"
import { guardedWrite, type Operated } from "../sends/guarded.js"
import { newOperationId } from "../sends/send-id.js"
import type { ServiceDeps } from "./deps.js"

/** How far back `events` looks without `since`, as in max-cli. */
export const EVENTS_DAYS = 7

/** A filtered list searches the newest this many: paging through every dialog hit FLOOD_WAIT (tg handoff §4.14). */
export const CHAT_SCAN = 200

/** Checked by the caller, in its own words (`checkedFilter`). */
export interface ChatFilter {
  search?: string
  kind?: string
  unread?: boolean
}

export interface PageWindow {
  limit?: number
  offset: number
}

export interface MarkedRead {
  chatId: Id
  /** `null`: up to the newest message. */
  until: Id | null
}

export interface ChatsService {
  /**
   * Newest first. A filtered list is cut from the newest `CHAT_SCAN` — or from every stored chat
   * offline — and `partial` says there were older chats that were not searched.
   */
  list(filter: ChatFilter, window: PageWindow): Promise<Page<Chat> & { partial: boolean }>
  show(chat: string): Promise<ChatCard>
  members(chat: string, window: PageWindow): Promise<Page<GroupMember> & { chatId: Id }>
  /** `since` in ms, parsed by the caller; `only` keeps the events named, comma-separated as typed. */
  events(chat: string, options: { since?: number; only?: string }): Promise<ChatEvents>
  inspect(link: string): Promise<LinkTarget>
  /** Through the guard; never counts toward the hourly limit. */
  markRead(request: { chat: string; until?: string }): Promise<Operated<MarkedRead>>
}

export const chatsService = (deps: ServiceDeps): ChatsService => ({
  list: async (filter, window) => {
    const filtering = filter.search !== undefined || filter.kind !== undefined || filter.unread === true
    if (!filtering) {
      const page = deps.offline
        ? await (await deps.store()).chats(await deps.account(), window)
        : await (await deps.connection()).chats(window)
      return { ...page, partial: false }
    }
    const scanned = deps.offline
      ? await (await deps.store()).chats(await deps.account(), { offset: 0 })
      : await (await deps.connection()).chats({ limit: CHAT_SCAN, offset: 0 })
    const found = scanned.items.filter(matches(filter))
    const end = window.limit === undefined ? found.length : window.offset + window.limit
    return { items: found.slice(window.offset, end), hasMore: found.length > end, partial: scanned.hasMore }
  },

  show: async (chat) => (await deps.connection()).chat(chat),

  members: async (chat, window) =>
    capability(await deps.connection(), "members", "list a group's members")(chat, window),

  events: async (chat, { since, only }) => {
    if (deps.offline) {
      throw new CliError("validation_error", "`chats events` reads the chat's history; with `--offline` there is none")
    }
    const from = since ?? Date.now() - EVENTS_DAYS * 86_400_000
    const found = await capability(
      await deps.connection(),
      "chatEvents",
      "read who joined or left",
    )(chat, {
      since: from,
    })
    const wanted = only === undefined ? undefined : new Set(only.split(",").map((name) => name.trim()))
    return wanted ? { ...found, events: found.events.filter((one) => wanted.has(one.event)) } : found
  },

  inspect: async (link) => {
    if (deps.offline) {
      throw new CliError("validation_error", "`chats inspect` asks the messenger about the link; not with --offline")
    }
    return capability(await deps.connection(), "inspect", "read a link")(link)
  },

  markRead: async ({ chat, until }) => {
    const connection = await deps.connection()
    const markRead = capability(connection, "markRead", "mark a chat read")
    const { id: chatId } = await connection.resolve(chat)
    const operationId = newOperationId()
    await guardedWrite(
      deps.guard,
      { operationId, chatId, kind: "read", ...(until === undefined ? {} : { messageId: until }) },
      () => markRead(chatId, until),
    )
    return { operationId, chatId, until: until ?? null }
  },
})

const matches = ({ search, kind, unread }: ChatFilter) => {
  const needle = search?.toLocaleLowerCase()
  return (chat: Chat) =>
    (needle === undefined || (chat.title ?? "").toLocaleLowerCase().includes(needle)) &&
    (kind === undefined || chat.kind === kind) &&
    (!unread || (chat.unreadCount ?? 0) > 0)
}
