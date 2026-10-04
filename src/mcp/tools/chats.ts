import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import type { MessengerAdapter } from "../../cli/messenger/port.js"
import { listed } from "../../cli/paging.js"
import type { SendGuard } from "../../sends/guard.js"
import { checkedFilter } from "../../services/chats.js"
import { CHAT_SCAN, EVENTS_DAYS, onlineDeps, servicesFor, storedDeps } from "../../services/index.js"
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
      served: async (services, { search, kind, unread, ...rest }, defaults) => {
        const { size, number, window } = paging(rest, defaults)
        const found = await services.chats.list(checkedFilter({ search, kind, unread }), window)
        return { ...envelope(found, number, size), ...(found.partial ? { partial: true } : {}) }
      },
    }),

    chats_events: tool({
      title: "Who joined or left a chat",
      description:
        "A chat's service messages since `since_time`: who joined, left, was added or removed, and by whom, oldest " +
        `first — event is join, leave, add, remove, create, title or pin. ${EVENTS_DAYS} days back if not given. ` +
        "`type` keeps only those events. Returns { items: [{ messageId, timestamp, event, by, people, title? }], page, " +
        "limit, hasMore, chatId, since }; hasMore when the history was longer than one run reads.",
      input: v.object({
        chat,
        since_time: v.optional(v.pipe(v.string(), v.description("an ISO 8601 time, or 2h / 1d ago"))),
        type: v.optional(v.pipe(v.string(), v.description("only these events, comma-separated"))),
      }),
      annotations: READ,
      online: async (adapter, args, { guard }) => {
        const { events, more, ...rest } = await chats(adapter, guard).events(args.chat, {
          ...(args.since_time === undefined ? {} : { since: momentOf(args.since_time, "since_time") }),
          ...(args.type ? { only: args.type } : {}),
        })
        return { ...listed(events), hasMore: more, ...rest }
      },
    }),

    chats_stats: tool({
      title: "A chat's numbers for a period",
      description:
        `Counts over a chat's stored messages since \`since_time\` (${EVENTS_DAYS} days back if not given): messages, ` +
        "senders, replies, threads, reactions, views and forwards where the messenger gave them, topPosts, and " +
        "questions { asked, answered, medianMinutesToAnswer }. `by` adds a series row per day or week. Reads the local " +
        "store only, so joins and leaves are not in it — chats_events has them. complete is false when the store does " +
        "not hold the chat whole: then every number is a lower bound, and fetch names the CLI command that fills it.",
      input: v.object({
        chat,
        since_time: v.optional(v.pipe(v.string(), v.description("an ISO 8601 time, or 2h / 1d ago"))),
        by: v.optional(v.picklist(["day", "week"])),
        timezone: v.optional(v.pipe(v.string(), v.description("the IANA timezone for calendar days"))),
      }),
      annotations: { ...READ, openWorldHint: false },
      stored: (store, account, args, defaults) =>
        servicesFor(storedDeps(messenger, store, account, defaults.guard)).chats.stats(args.chat, {
          ...(args.since_time === undefined ? {} : { since: momentOf(args.since_time, "since_time") }),
          ...(args.by ? { by: args.by } : {}),
          ...(args.timezone === undefined ? {} : { timezone: args.timezone }),
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

    chats_members_audit: tool({
      title: "Members that look like bots",
      description:
        "Members of a group that look like bots, highest score first: { id, name, username, score, reasons }. " +
        "Reasons: bot, scam, fake, deleted, no_photo, no_username, odd_name, never_wrote, link_first, burst_join, " +
        "mass_invited. A score is a hint, never a verdict; the owner and admins are left out. Reads the member list " +
        "a page at a time (budget pages); unknown names the signals the messenger gave nothing for; more says some " +
        "members were not read. Removes nobody — that is chats_moderate, with the owner's confirmation.",
      input: v.object({
        chat,
        budget: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.description("pages of members to read"))),
        min_score: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
      }),
      annotations: READ,
      online: (adapter, args, { guard }) =>
        chats(adapter, guard).audit(args.chat, {
          ...(args.budget === undefined ? {} : { budget: args.budget }),
          ...(args.min_score === undefined ? {} : { minScore: args.min_score }),
        }),
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
      served: (services, args) => services.chats.show(args.chat),
    }),
  }
}
