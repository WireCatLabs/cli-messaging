import * as v from "valibot"
import { contactsIn } from "../../cli/messenger/contacts-command.js"
import type { Messenger } from "../../cli/messenger/context.js"
import { type AnyTool, envelope, limit, page, paging, READ, tool } from "../tool.js"

export const contactsTools = (_messenger: Messenger): Record<string, AnyTool> => {
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
        const chats = (await adapter.chats({ offset: 0 })).items
        const found = contactsIn(chats, { order: order ?? "recent", ...(search ? { search } : {}), ...window })
        return envelope(found, number, size)
      },
    }),

    contacts_show: tool({
      title: "Show a person",
      description: "One person and the chats shared with them.",
      input: v.object({
        person: v.pipe(v.string(), v.minLength(1), v.description("person id, @username, or part of a name")),
      }),
      annotations: READ,
      online: (adapter, args) => adapter.contact(args.person),
    }),
  }
}
