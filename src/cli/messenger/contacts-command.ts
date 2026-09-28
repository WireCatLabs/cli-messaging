import { CliError } from "@leemour/cli-core"
import { Command } from "commander"
import type { Chat, Contact, Page } from "../../domain/models.js"
import { renderPage, window, withPaging } from "../paging.js"
import { type Messenger, messengerContext } from "./context.js"

/**
 * A contact is somebody this account has a one-to-one chat with — a query over the chat list, never
 * a flag somebody maintains (max-cli `NEED-105`). So the list works offline from the stored chats.
 */
export const contactsCommand = (messenger: Messenger): Command => {
  const contacts = new Command("contacts").description("people this account has a one-to-one chat with")

  contacts.addCommand(
    withPaging(new Command("list").description("people you have a one-to-one chat with"))
      .option("--order <recent|name>", "newest conversation first, or alphabetical", "recent")
      .option("--search <text>", "only people whose name or @username contains this")
      .action(async function (this: Command) {
        const { order, search } = this.opts<{ order: string; search?: string }>()
        if (order !== "recent" && order !== "name") {
          throw new CliError("validation_error", `--order is recent or name, not "${order}"`)
        }
        const context = messengerContext(this, messenger)
        const chats = context.settings.offline
          ? await context.withStore((store, account) => store.chats(account, {}).items)
          : await context.withMessenger(async (connection) => (await connection.chats({ offset: 0 })).items)
        renderPage(context, contactsIn(chats, { order, ...(search ? { search } : {}), ...window(context.settings) }))
      }),
  )

  contacts
    .command("show")
    .description("one person and the chats you share with them")
    .argument("<person>", "their id, @username, or part of their name")
    .action(async function (this: Command, person: string) {
      const context = messengerContext(this, messenger)
      context.renderer.result(await context.withMessenger((connection) => connection.contact(person)))
    })

  return contacts
}

export const contactsIn = (
  chats: readonly Chat[],
  { order, search, limit, offset }: { order: "recent" | "name"; search?: string; limit?: number; offset: number },
): Page<Contact> => {
  const wanted = search?.trim().toLowerCase()
  const people = chats
    .filter((chat) => chat.kind === "dialog")
    .map(toContact)
    .filter(
      (person) => !wanted || [person.name, person.username].some((field) => field?.toLowerCase().includes(wanted)),
    )
    .sort(order === "name" ? byName : byRecency)
  const end = limit === undefined ? people.length : offset + limit
  return { items: people.slice(offset, end), hasMore: people.length > end }
}

const toContact = (chat: Chat): Contact => ({
  id: chat.id,
  name: chat.title,
  username: typeof chat.providerMetadata?.username === "string" ? chat.providerMetadata.username : null,
  description: null,
  lastMessagedAt: chat.lastMessageAt,
})

const byRecency = (a: Contact, b: Contact) => (b.lastMessagedAt ?? "").localeCompare(a.lastMessagedAt ?? "")
const byName = (a: Contact, b: Contact) => (a.name ?? "").localeCompare(b.name ?? "")
