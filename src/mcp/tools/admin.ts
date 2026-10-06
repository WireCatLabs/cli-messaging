import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import type { MessengerAdapter } from "../../cli/messenger/port.js"
import { ADMIN_RIGHTS, GROUP_SETTINGS } from "../../domain/models.js"
import type { SendGuard } from "../../sends/guard.js"
import { onlineDeps, servicesFor } from "../../services/index.js"
import { type AnyTool, chatOf, READ, tool, WRITE } from "../tool.js"

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
      permission: "groups",
      online: (adapter, args, { guard }) => admin(adapter, guard).join(args.link),
    }),
    chats_leave: tool({
      title: "Leave a group",
      description: "Leave a group or channel; the others in it see it. Only when the owner asked to leave this chat.",
      input: v.object({ chat: chatOf(messenger) }),
      annotations: WRITE,
      permission: "groups",
      online: (adapter, args, { guard }) => admin(adapter, guard).leave(args.chat),
    }),
    chats_update: tool({
      title: "Change a group",
      description:
        "Rename a group or channel, change its description, or turn its settings on or off; its members see the " +
        "change. Only when the owner asked for this change.",
      input: v.object({
        chat: chatOf(messenger),
        title: v.optional(v.pipe(v.string(), v.minLength(1))),
        description: v.optional(v.string()),
        settings: v.optional(
          v.pipe(
            v.partial(
              v.object(
                Object.fromEntries((messenger.groupSettings ?? GROUP_SETTINGS).map((key) => [key, v.boolean()])),
              ),
            ),
            v.description("true turns a setting on, false off; one left out stays as it is"),
          ),
        ),
      }),
      annotations: WRITE,
      permission: "groups",
      online: (adapter, args, { guard }) =>
        admin(adapter, guard).update(args.chat, {
          ...(args.title === undefined ? {} : { title: args.title }),
          ...(args.description === undefined ? {} : { description: args.description }),
          ...(args.settings === undefined ? {} : { settings: args.settings }),
        }),
    }),
    chats_link_show: tool({
      title: "A group's invite link",
      description: "The invite link of a group or channel, when the owner may see it. Reading changes nothing.",
      input: v.object({ chat: chatOf(messenger) }),
      annotations: READ,
      online: (adapter, args, { guard }) => admin(adapter, guard).link(args.chat),
    }),
    chats_link_reset: tool({
      title: "Replace a group's invite link",
      description:
        "Make a new invite link for a group or channel; the old one stops working for everyone who has it. " +
        "Only when the owner asked.",
      input: v.object({ chat: chatOf(messenger) }),
      annotations: WRITE,
      permission: "groups",
      online: (adapter, args, { guard }) => admin(adapter, guard).resetLink(args.chat),
    }),
    chats_members_add: tool({
      title: "Add people to a group",
      description:
        "Add people to a group; each is told. Only the people the owner named, to the group the owner named.",
      input: v.object({
        chat: chatOf(messenger),
        people: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1)),
        history: v.optional(
          v.pipe(
            v.boolean(),
            v.description("they also see the messages from before; refused where the messenger cannot"),
          ),
        ),
      }),
      annotations: WRITE,
      permission: "groups",
      online: (adapter, args, { guard }) =>
        admin(adapter, guard).addMembers(args.chat, args.people, args.history === true ? { history: true } : {}),
    }),
    chats_members_remove: tool({
      title: "Remove people from a group",
      description: "Remove people from a group; their messages stay. Only the people the owner named.",
      input: v.object({
        chat: chatOf(messenger),
        people: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1)),
      }),
      annotations: WRITE,
      permission: "groups",
      online: (adapter, args, { guard }) => admin(adapter, guard).removeMembers(args.chat, args.people),
    }),
    chats_admins_add: tool({
      title: "Make someone an admin",
      description: "Make a member of a group an admin with these rights. Only when the owner asked, with these rights.",
      input: v.object({
        chat: chatOf(messenger),
        person: v.pipe(v.string(), v.minLength(1)),
        rights: v.pipe(v.array(v.picklist(messenger.adminRights ?? ADMIN_RIGHTS)), v.minLength(1)),
      }),
      annotations: WRITE,
      permission: "groups",
      online: (adapter, args, { guard }) => admin(adapter, guard).addAdmin(args.chat, args.person, args.rights),
    }),
    chats_admins_remove: tool({
      title: "Take admin rights back",
      description: "Take a group admin's rights back; they stay a member. Only when the owner asked.",
      input: v.object({ chat: chatOf(messenger), person: v.pipe(v.string(), v.minLength(1)) }),
      annotations: WRITE,
      permission: "groups",
      online: (adapter, args, { guard }) => admin(adapter, guard).removeAdmin(args.chat, args.person),
    }),
  }
}
