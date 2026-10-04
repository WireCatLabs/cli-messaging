import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import type { MessengerAdapter } from "../../cli/messenger/port.js"
import type { SendGuard } from "../../sends/guard.js"
import { onlineDeps, phoneOf, servicesFor, storedDeps } from "../../services/index.js"
import { momentOf } from "../../services/moment.js"
import { CONTEXT_BYTES, CONTEXT_MESSAGES } from "../../services/person-context.js"
import { type AnyTool, envelope, limit, page, paging, READ, tool } from "../tool.js"

export const contactsTools = (messenger: Messenger): Record<string, AnyTool> => {
  const people = (adapter: MessengerAdapter, guard: SendGuard) =>
    servicesFor(onlineDeps(messenger, adapter, guard)).people
  return {
    contacts_list: tool({
      title: "List contacts",
      description: "People the owner has a one-to-one chat with. Returns { items, page, limit, hasMore }.",
      input: v.object({
        search: v.optional(v.pipe(v.string(), v.minLength(1), v.description("only people whose name contains this"))),
        order: v.optional(v.picklist(["recent", "name"])),
        limit,
        page,
      }),
      annotations: READ,
      served: async (services, { search, order, ...rest }, defaults) => {
        const { size, number, window } = paging(rest, defaults)
        const found = await services.people.list({
          order: order ?? "recent",
          ...(search ? { search } : {}),
          ...window,
        })
        return envelope(found, number, size)
      },
    }),

    contacts_lookup: tool({
      title: "Find a person by phone",
      description:
        "Who has this phone number, where their privacy lets the owner find them: { id, name, username }. " +
        "not_found otherwise. Nothing is added to the owner's contacts.",
      input: v.object({ phone: v.pipe(v.string(), v.description("with the country code; spaces and + are fine")) }),
      annotations: READ,
      online: (adapter, args, { guard }) => people(adapter, guard).lookup(phoneOf(args.phone)),
    }),

    contacts_show: tool({
      title: "Show a person",
      description: "One person and the chats shared with them.",
      input: v.object({
        person: v.pipe(v.string(), v.minLength(1), v.description("person id, @username, or part of a name")),
      }),
      annotations: READ,
      served: (services, args) => services.people.show(args.person),
    }),

    contacts_context: tool({
      title: "What is known about a person",
      description:
        "Everything the local store holds about one person, in every messenger linked to them: person { uid, " +
        "identities }, shared chats, last { fromThem, fromMe, fromThemAnywhere }, recent { direct, groups }, " +
        "mentions — each message with a locator. complete is false when a shared chat is not stored whole; notRead " +
        "names it and why. Reads the store only; marks nothing read. Never assumes two people with one name are one.",
      input: v.object({
        person: v.pipe(v.string(), v.minLength(1), v.description("person id, @username, or part of a name")),
        limit: v.optional(
          v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100), v.description("at most this many per list")),
        ),
        since_time: v.optional(v.pipe(v.string(), v.description("an ISO 8601 time, or 2h / 1d ago"))),
      }),
      annotations: { ...READ, openWorldHint: false },
      stored: (store, account, args, defaults) =>
        servicesFor(storedDeps(messenger, store, account, defaults.guard)).people.context(args.person, {
          messages: args.limit ?? CONTEXT_MESSAGES,
          bytes: CONTEXT_BYTES,
          ...(args.since_time === undefined ? {} : { since: momentOf(args.since_time, "since_time") }),
        }),
    }),
  }
}
