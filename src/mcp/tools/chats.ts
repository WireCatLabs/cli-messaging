import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import type { MessengerAdapter } from "../../cli/messenger/port.js"
import type { SendGuard } from "../../sends/guard.js"
import { checkedFilter } from "../../services/chats.js"
import { CHAT_SCAN, EVENTS_DAYS, onlineDeps, servicesFor } from "../../services/index.js"
import { momentOf } from "../../services/moment.js"
import { type AnyTool, chatOf, envelope, limit, page, paging, READ, tool } from "../tool.js"

export const chatsTools = (messenger: Messenger): Record<string, AnyTool> => {
  const chat = chatOf(messenger)
  const chats = (adapter: MessengerAdapter, guard: SendGuard) =>
    servicesFor(onlineDeps(messenger, adapter, guard)).chats
  return {
    chats_list: tool({
      title: "List chats",
      description:
        "Chats the owner is in, most recent first. Use it to find a chat's id before reading or sending. " +
        `With search, kind or unread, only the newest ${CHAT_SCAN} chats are searched, and partial says there were ` +
        "older ones. Returns { items, page, limit, hasMore, partial? }.",
      input: v.object({
        search: v.optional(v.pipe(v.string(), v.minLength(3), v.description("only chats whose name contains this"))),
        kind: v.optional(v.picklist(["dialog", "group", "channel", "saved"])),
        unread: v.optional(v.pipe(v.boolean(), v.description("only chats with unread messages"))),
        limit,
        page,
      }),
      annotations: READ,
      online: async (adapter, { search, kind, unread, ...rest }, defaults) => {
        const { size, number, window } = paging(rest, defaults)
        const found = await chats(adapter, defaults.guard).list(checkedFilter({ search, kind, unread }), window)
        return { ...envelope(found, number, size), ...(found.partial ? { partial: true } : {}) }
      },
    }),

    chats_events: tool({
      title: "Who joined or left a chat",
      description:
        "A chat's service messages since `since`: who joined, left, was added or removed, and by whom, oldest " +
        `first — event is join, leave, add, remove, create, title or pin. ${EVENTS_DAYS} days back if not given. ` +
        "Returns { chatId, since, events: [{ messageId, timestamp, event, by, people, title? }], more }.",
      input: v.object({
        chat,
        since: v.optional(v.pipe(v.string(), v.description("an ISO 8601 time, or 2h / 1d ago"))),
        event: v.optional(v.pipe(v.string(), v.description("only these events, comma-separated"))),
      }),
      annotations: READ,
      online: (adapter, args, { guard }) =>
        chats(adapter, guard).events(args.chat, {
          ...(args.since === undefined ? {} : { since: momentOf(args.since, "since") }),
          ...(args.event ? { only: args.event } : {}),
        }),
    }),

    chats_members: tool({
      title: "Everyone in a group",
      description:
        "A group's members, a page at a time: { id, name, username, role?, lastSeenAt? }. role is owner, admin or " +
        "member; lastSeenAt is null when their privacy hides it. Returns { items, page, limit, hasMore }.",
      input: v.object({ chat, limit, page }),
      annotations: READ,
      online: async (adapter, { chat: reference, ...rest }, defaults) => {
        const { size, number, window } = paging(rest, defaults)
        const found = await chats(adapter, defaults.guard).members(reference, window)
        return { ...envelope(found, number, size), chatId: found.chatId }
      },
    }),

    chats_inspect: tool({
      title: "What a link leads to",
      description:
        "What an invite or public link leads to, read without joining: { kind, title, id, username, " +
        "participantsCount, description, member, approvalNeeded? }. id is null for a private chat the owner is not in.",
      input: v.object({ link: v.pipe(v.string(), v.minLength(1), v.description("an invite link or a public one")) }),
      annotations: READ,
      online: (adapter, args, { guard }) => chats(adapter, guard).inspect(args.link),
    }),

    chats_show: tool({
      title: "Show a chat",
      description: "One chat: its kind, unread count, last message time and who is in it.",
      input: v.object({ chat }),
      annotations: READ,
      online: (adapter, args, { guard }) => chats(adapter, guard).show(args.chat),
    }),
  }
}
