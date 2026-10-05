import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import { capability } from "../../cli/messenger/port.js"
import { onlineDeps, servicesFor } from "../../services/index.js"
import { type AnyTool, chatOf, envelope, limit, page, paging, READ, tool, WRITE } from "../tool.js"

export const topicsTools = (messenger: Messenger): Record<string, AnyTool> => ({
  topics_list: tool({
    title: "A forum group's topics",
    description:
      "The topics of a forum group, newest activity first: { id, title, closed, pinned, unreadCount, " +
      "lastMessageAt, createdAt }. A message in a topic carries its id as threadId. `search` matches titles. " +
      "Returns { items, page, limit, hasMore }.",
    input: v.object({
      chat: chatOf(messenger),
      search: v.optional(v.pipe(v.string(), v.minLength(1), v.description("words from the topic's title"))),
      limit,
      page,
    }),
    annotations: READ,
    online: async (adapter, { chat, search, ...rest }, defaults) => {
      const { size, number, window } = paging(rest, defaults)
      const found = await capability(
        adapter,
        "topics",
        "list forum topics",
      )(chat, {
        ...window,
        ...(search === undefined ? {} : { search }),
      })
      return envelope(found, number, size)
    },
  }),
})

export const topicWriteTools = (messenger: Messenger): Record<string, AnyTool> => ({
  topics_enable: tool({
    title: "Enable forum topics",
    description:
      "Only when the owner requested this change. A basic group requires explicit upgrade; its id changes. A partial failure reports the new chat id. Only the group owner can enable topics.",
    input: v.object({ chat: chatOf(messenger), upgrade: v.optional(v.boolean()) }),
    annotations: WRITE,
    permission: "groups",
    online: (adapter, args, { guard }) =>
      servicesFor(onlineDeps(messenger, adapter, guard)).topics.enable(args.chat, { upgrade: args.upgrade === true }),
  }),
  topics_create: tool({
    title: "Create a forum topic",
    description:
      "Only when the owner requested this topic. The group must already have topics enabled. On outcome_unknown, check topics_list and do not repeat the creation, even with the same send_id.",
    input: v.object({
      chat: chatOf(messenger),
      title: v.pipe(v.string(), v.minLength(1)),
      send_id: v.optional(v.pipe(v.string(), v.minLength(1))),
    }),
    annotations: WRITE,
    permission: "groups",
    online: (adapter, args, { guard }) =>
      servicesFor(onlineDeps(messenger, adapter, guard)).topics.create(args.chat, args.title, {
        ...(args.send_id === undefined ? {} : { sendId: args.send_id }),
      }),
  }),
  topics_edit: tool({
    title: "Rename, close, reopen, pin or unpin a forum topic",
    description:
      "Only when the owner requested this change. title renames the topic; closed: true closes it to new messages, " +
      "false reopens it; pinned: true pins it, false unpins it; hidden hides or shows the General topic. Returns { operationId, chatId, topic }. On outcome_unknown, repeating it is safe.",
    input: v.object({
      chat: chatOf(messenger),
      topic: v.pipe(v.string(), v.minLength(1), v.description("the topic id, from topics_list")),
      title: v.optional(v.pipe(v.string(), v.minLength(1))),
      closed: v.optional(v.boolean()),
      pinned: v.optional(v.boolean()),
      hidden: v.optional(v.pipe(v.boolean(), v.description("the General topic only"))),
    }),
    annotations: WRITE,
    _meta: APPROVE,
    permission: "groups",
    online: (adapter, args, { guard }) =>
      servicesFor(onlineDeps(messenger, adapter, guard)).topics.edit(args.chat, args.topic, {
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.closed === undefined ? {} : { closed: args.closed }),
        ...(args.pinned === undefined ? {} : { pinned: args.pinned }),
        ...(args.hidden === undefined ? {} : { hidden: args.hidden }),
      }),
  }),
  topics_order: tool({
    title: "Order the pinned forum topics",
    description:
      "Only when the owner requested this order. Puts the pinned topics in the order given; it pins and unpins " +
      "nothing. Returns { operationId, chatId, order }. On outcome_unknown, repeating it is safe.",
    input: v.object({
      chat: chatOf(messenger),
      topics: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1)),
    }),
    annotations: WRITE,
    _meta: APPROVE,
    permission: "groups",
    online: (adapter, args, { guard }) =>
      servicesFor(onlineDeps(messenger, adapter, guard)).topics.order(args.chat, args.topics),
  }),
})
