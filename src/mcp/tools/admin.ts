import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import type { MessengerAdapter } from "../../cli/messenger/port.js"
import type { SendGuard } from "../../sends/guard.js"
import { onlineDeps, servicesFor } from "../../services/index.js"
import { type AnyTool, APPROVE, chatOf, tool, WRITE } from "../tool.js"

/** Groups the owner makes, joins and leaves: other people see each one, so each is behind its permission level. */
export const adminTools = (messenger: Messenger): Record<string, AnyTool> => {
  const admin = (adapter: MessengerAdapter, guard: SendGuard) =>
    servicesFor(onlineDeps(messenger, adapter, guard)).admin
  return {
    chats_create: tool({
      title: "Create a group",
      description:
        "Create a group, or a channel, with these people in it; each of them is told they were added. " +
        "Only when the owner asked for this group with these people.",
      input: v.object({
        title: v.pipe(v.string(), v.minLength(1)),
        people: v.optional(v.array(v.pipe(v.string(), v.minLength(1)))),
        channel: v.optional(v.pipe(v.boolean(), v.description("a channel people join by its link, not a group"))),
      }),
      annotations: WRITE,
      _meta: APPROVE,
      permission: "groups",
      online: (adapter, args, { guard }) =>
        admin(adapter, guard).create({ title: args.title, people: args.people ?? [], channel: args.channel === true }),
    }),
    chats_join: tool({
      title: "Join a group by its link",
      description:
        "Join a group or channel by an invite or public link; the others in it see it. Only when the owner asked.",
      input: v.object({ link: v.pipe(v.string(), v.minLength(1)) }),
      annotations: WRITE,
      _meta: APPROVE,
      permission: "groups",
      online: (adapter, args, { guard }) => admin(adapter, guard).join(args.link),
    }),
    chats_leave: tool({
      title: "Leave a group",
      description: "Leave a group or channel; the others in it see it. Only when the owner asked to leave this chat.",
      input: v.object({ chat: chatOf(messenger) }),
      annotations: WRITE,
      _meta: APPROVE,
      permission: "groups",
      online: (adapter, args, { guard }) => admin(adapter, guard).leave(args.chat),
    }),
  }
}
