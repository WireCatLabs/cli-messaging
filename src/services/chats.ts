import { CliError } from "@leemour/cli-core"
import { capability } from "../cli/messenger/port.js"
import { threadIdOf } from "../cli/messenger/thread.js"
import type {
  Chat,
  ChatCard,
  ChatEvents,
  ChatKind,
  GroupMember,
  Id,
  LinkTarget,
  Member,
  Message,
  Page,
} from "../domain/models.js"
import { timezoneOf } from "../search/lucene/dates.js"
import { codeOf, guardedWrite, type Operated } from "../sends/guarded.js"
import { newOperationId } from "../sends/send-id.js"
import type { AccountKey, MessageStore } from "../store/store.js"
import { type ChatStats, chatStats, type StatsPeriod } from "./chat-stats.js"
import { fromStore, nothingStored, type ServiceDeps, storeIfOpen } from "./deps.js"
import {
  AUDIT_BUDGET,
  AUDIT_MIN_SCORE,
  AUDIT_PAGE,
  AUDIT_PAUSE_MS,
  auditMembers,
  type MembersAudit,
} from "./members-audit.js"
import { storedChatId } from "./messages.js"

/** How far back `events` looks without `since`, as in max-cli. */
export const EVENTS_DAYS = 7

/** How many stored messages one read of the store takes while `stats` walks the period. */
const STATS_PAGE = 1000

/** @deprecated A filtered list now searches every chat; kept because `./services` exports it. */
export const CHAT_SCAN = 200

/** Checked by the caller, in its own words (`checkedFilter`). */
export interface ChatFilter {
  search?: string
  kind?: string
  unread?: boolean
}

export const CHAT_KINDS: ChatKind[] = ["dialog", "group", "channel", "saved"]

/** Refuses a filter that would match nothing useful, before anything is asked. */
export const checkedFilter = ({ search, kind, unread }: ChatFilter): ChatFilter => {
  if (search !== undefined && search.trim().length < 3) {
    throw new CliError("validation_error", `--search takes at least 3 characters, got "${search}"`)
  }
  if (kind !== undefined && !CHAT_KINDS.includes(kind as ChatKind)) {
    throw new CliError("validation_error", `--kind is one of ${CHAT_KINDS.join(", ")} — not "${kind}"`)
  }
  return {
    ...(search === undefined ? {} : { search: search.trim() }),
    ...(kind ? { kind } : {}),
    ...(unread ? { unread } : {}),
  }
}

export interface PageWindow {
  limit?: number
  offset: number
}

export interface MarkedRead {
  chatId: Id
  /** `null`: up to the newest message. */
  until: Id | null
  /** Only this forum topic was marked read. */
  threadId?: Id
}

export interface ChatsService {
  /**
   * Newest first. A filtered list searches every chat — Telegram's unread can sit anywhere in a list
   * sorted by the last message — and `partial` says the messenger could not list them all.
   */
  list(filter: ChatFilter, window: PageWindow): Promise<Page<Chat> & { partial: boolean }>
  show(chat: string): Promise<ChatCard>
  members(chat: string, window: PageWindow): Promise<Page<GroupMember> & { chatId: Id }>
  /** `since` in ms, parsed by the caller; `only` keeps the events named, comma-separated as typed. */
  events(chat: string, options: { since?: number; only?: string }): Promise<ChatEvents>
  inspect(link: string): Promise<LinkTarget>
  /**
   * Counts over the stored messages since `since` (ms; `EVENTS_DAYS` ago when unset). Joins and leaves
   * come from the messenger, so they are absent offline; the rest never asks it.
   */
  stats(chat: string, options: { since?: number; by?: StatsPeriod; timezone?: string }): Promise<ChatStats>
  /**
   * Members that look like bots, each with its reasons. Reads the member list a page at a time, at most
   * `budget` pages with a pause between them, and never asks about one person. Acts on nobody.
   */
  audit(chat: string, options: { budget?: number; minScore?: number; pauseMs?: number }): Promise<MembersAudit>
  /** Through the guard; never counts toward the hourly limit. */
  markRead(request: { chat: string; until?: string; threadId?: string }): Promise<Operated<MarkedRead>>
}

export const chatsService = (deps: ServiceDeps): ChatsService => ({
  list: async (filter, window) => {
    const filtering = filter.search !== undefined || filter.kind !== undefined || filter.unread === true
    if (!filtering) {
      const page = fromStore(deps)
        ? await (await deps.store()).chats(await deps.account(), window)
        : await capability(await deps.connection(), "chats", "list chats")(window)
      return { ...page, partial: false }
    }
    const scanned = fromStore(deps)
      ? await (await deps.store()).chats(await deps.account(), { offset: 0 })
      : await capability(await deps.connection(), "chats", "list chats")({ offset: 0 })
    const found = scanned.items.filter(matches(filter))
    const end = window.limit === undefined ? found.length : window.offset + window.limit
    return { items: found.slice(window.offset, end), hasMore: found.length > end, partial: scanned.hasMore }
  },

  show: async (chat) => {
    if (fromStore(deps)) {
      const store = await deps.store()
      const account = await deps.account()
      const pushed = deps.reads === "store"
      const missing = (id: string) =>
        new CliError("not_found", pushed ? nothingStored(deps.messenger) : `no stored chat ${id}`)
      const id = await storedChatId(deps.messenger, chat, store, account).catch((error: unknown) => {
        throw pushed && codeOf(error) === "not_found" ? missing(chat) : error
      })
      const found = (await store.chats(account, {})).items.find((one) => one.id === id)
      if (!found) throw missing(id)
      return { ...found, members: await storedMembers(store, account, found.id) }
    }
    const connection = await deps.connection()
    const shown = await connection.chat(chat)
    const card =
      connection.group && (shown.kind === "group" || shown.kind === "channel")
        ? (({ description, link, settings }) => ({ ...shown, description, link, settings }))(
            await connection.group(shown.id),
          )
        : shown
    if (card.members !== null || card.kind === "channel") return card
    const held = await storeIfOpen(deps)
    return held ? { ...card, members: await storedMembers(held.store, held.account, card.id) } : card
  },

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

  stats: async (chat, { since, by, timezone }) => {
    const store = await deps.store()
    const account = await deps.account()
    const chatId = await storedChatId(deps.messenger, chat, store, account)
    const [completeness] = await store.chatCompleteness(account, [chatId])
    if (!completeness) throw new CliError("not_found", `no stored chat ${chatId}`)
    const from = since ?? Date.now() - EVENTS_DAYS * 86_400_000
    const until = Date.now()
    const messages = await storedSince(store, account, chatId, new Date(from).toISOString())
    const connection = fromStore(deps) ? undefined : await deps.connection()
    const events = connection?.chatEvents ? await connection.chatEvents(chatId, { since: from }) : undefined
    const admins = (await connection?.admins?.(chatId)) ?? null
    const stats = chatStats(messages, {
      chatId,
      since: from,
      until,
      completeness,
      ...(events ? { events } : {}),
      admins,
      ...(by ? { by } : {}),
      timezone: timezoneOf(timezone),
    })
    return completeness.state === "complete"
      ? stats
      : { ...stats, fetch: `${deps.messenger.app.command} store fetch ${chatId}` }
  },

  audit: async (chat, { budget = AUDIT_BUDGET, minScore = AUDIT_MIN_SCORE, pauseMs = AUDIT_PAUSE_MS }) => {
    if (fromStore(deps)) {
      throw new CliError(
        "validation_error",
        "`chats members audit` reads the member list from the messenger; not offline",
      )
    }
    const connection = await deps.connection()
    const members = capability(connection, "members", "list a group's members")
    const read: GroupMember[] = []
    let chatId: Id | undefined
    let more = true
    for (let page = 0; page < budget && more; page++) {
      if (page > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs))
      const found = await members(chatId ?? chat, { limit: AUDIT_PAGE, offset: read.length })
      chatId = found.chatId
      read.push(...found.items)
      more = found.hasMore && found.items.length > 0
    }
    const id = chatId ?? chat
    const held = await storeIfOpen(deps)
    const stored = held ? await storedFacts(held.store, held.account, id) : undefined
    const { items, unknown } = auditMembers(read, {
      firstMessages: stored?.firstMessages,
      self: connection.self(),
      minScore,
    })
    return {
      chatId: id,
      read: read.length,
      participantsCount: stored?.participantsCount ?? null,
      more,
      unknown,
      ...(stored?.completeness ? { completeness: stored.completeness } : {}),
      ...(stored?.completeness && stored.completeness.state !== "complete"
        ? { fetch: `${deps.messenger.app.command} store fetch ${id}` }
        : {}),
      items,
    }
  },

  markRead: async ({ chat, until, threadId: typedThread }) => {
    const threadId = threadIdOf(typedThread)
    const connection = await deps.connection()
    let act: (chatId: Id) => Promise<void>
    if (threadId === undefined) {
      const markRead = capability(connection, "markRead", "mark a chat read")
      act = (chatId) => markRead(chatId, until)
    } else {
      const markTopicRead = capability(connection, "markTopicRead", "mark a forum topic read")
      act = (chatId) => markTopicRead(chatId, threadId, until)
    }
    const { id: chatId } = await connection.resolve(chat)
    const operationId = newOperationId()
    await guardedWrite(
      deps.guard,
      {
        operationId,
        chatId,
        kind: "read",
        ...(until === undefined ? {} : { messageId: until }),
        ...(threadId === undefined ? {} : { threadId }),
      },
      () => act(chatId),
    )
    return { operationId, chatId, until: until ?? null, ...(threadId === undefined ? {} : { threadId }) }
  },
})

/** Each sender's first stored message in the chat; `undefined` when the store holds none of it. */
const storedFacts = async (store: MessageStore, account: AccountKey, chatId: Id) => {
  const chat = (await store.chats(account, {})).items.find((one) => one.id === chatId)
  const [completeness] = await store.chatCompleteness(account, [chatId])
  const firstMessages = new Map<Id, Message>()
  let before: Id | undefined
  for (;;) {
    const page = await store.messages(account, chatId, { limit: STATS_PAGE, ...(before ? { before } : {}) })
    for (const message of [...page.items].reverse()) if (message.senderId) firstMessages.set(message.senderId, message)
    const oldest = page.items[0]
    if (!page.hasMore || !oldest) break
    before = oldest.id
  }
  return {
    participantsCount: chat?.participantsCount ?? null,
    completeness,
    firstMessages: firstMessages.size === 0 ? undefined : firstMessages,
  }
}

/** Oldest first. */
const storedSince = async (store: MessageStore, account: AccountKey, chatId: Id, since: string): Promise<Message[]> => {
  const pages: Message[][] = []
  let before: Id | undefined
  for (;;) {
    const page = await store.messages(account, chatId, { limit: STATS_PAGE, since, ...(before ? { before } : {}) })
    pages.unshift(page.items)
    const oldest = page.items[0]
    if (!page.hasMore || !oldest) return pages.flat()
    before = oldest.id
  }
}

/** `null` when no member list was ever saved: not knowing who is there is not nobody being there. */
const storedMembers = async (store: MessageStore, account: AccountKey, chatId: Id): Promise<Member[] | null> => {
  const members = (await store.members(account, chatId)).filter((one) => one.id !== account.account)
  return members.length === 0 ? null : members
}

const matches = ({ search, kind, unread }: ChatFilter) => {
  const needle = search?.toLocaleLowerCase()
  return (chat: Chat) =>
    (needle === undefined || (chat.title ?? "").toLocaleLowerCase().includes(needle)) &&
    (kind === undefined || chat.kind === kind) &&
    (!unread || (chat.unreadCount ?? 0) > 0)
}
