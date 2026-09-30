import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import type { MessengerAdapter } from "../../cli/messenger/port.js"
import type { SendGuard } from "../../sends/guard.js"
import { onlineDeps, phoneOf, servicesFor } from "../../services/index.js"
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
      online: async (adapter, { search, order, ...rest }, defaults) => {
        const { size, number, window } = paging(rest, defaults)
        const found = await people(adapter, defaults.guard).list({
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
      online: (adapter, args, { guard }) => people(adapter, guard).show(args.person),
    }),
  }
}
