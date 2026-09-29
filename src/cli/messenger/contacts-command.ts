import { CliError } from "@leemour/cli-core"
import { Command } from "commander"
import type { Chat, Contact, Member, Page } from "../../domain/models.js"
import type { AccountKey, MessageStore } from "../../store/store.js"
import { readSecret } from "../../terminal/prompt.js"
import { renderPage, window, withPaging } from "../paging.js"
import { type Messenger, messengerContext } from "./context.js"
import { capability } from "./port.js"

/** Digits, with the `+` and the spaces, dashes and brackets people type dropped. */
export const phoneOf = (typed: string): string => {
  const digits = typed.replace(/[\s()+-]/g, "")
  if (!/^\d{6,15}$/.test(digits)) {
    throw new CliError("validation_error", "that is not a phone number — digits, with a country code")
  }
  return digits
}

export interface ContactSync {
  added: number
  changed: number
  known: number
}

/** What the store did not know yet, and what it knew differently; then everyone, saved. */
export const syncPeople = async (store: MessageStore, account: AccountKey, people: Member[]): Promise<ContactSync> => {
  const before = await store.people(account.provider, { account: account.account })
  let added = 0
  let changed = 0
  for (const person of people) {
    const known = before.get(person.id)
    if (!known) added += 1
    else if (known.name !== person.name || known.username !== person.username) changed += 1
  }
  await store.savePeople(account, people)
  return { added, changed, known: (await store.people(account.provider, { account: account.account })).all().length }
}

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
          ? await context.withStore(async (store, account) => (await store.chats(account, {})).items)
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

  /**
   * ⚠ **The number is asked for or piped, never an argument**: argv is read by `ps` and kept by shell
   * history, and a phone number is personal data.
   */
  contacts
    .command("lookup")
    .description("who has this phone number — asks for it, or reads it from stdin; never an argument")
    // Commander's own refusal would repeat the number on stderr.
    .allowExcessArguments()
    .action(async function (this: Command) {
      if (this.args.length > 0) {
        throw new CliError(
          "validation_error",
          "the phone number is never an argument — pipe it in, or type it when asked",
        )
      }
      const context = messengerContext(this, messenger)
      const phone = phoneOf(await readSecret("phone number: ", { input: context.stdin, echo: true }))
      context.renderer.result(
        await context.withMessenger((adapter) => capability(adapter, "lookup", "find a person by phone")(phone)),
      )
    })

  contacts
    .command("sync")
    .description("take the whole contact list from the messenger into the local store")
    .action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      if (context.settings.offline) {
        throw new CliError("validation_error", "`contacts sync` takes the list from the messenger; not with --offline")
      }
      const people = await context.withMessenger((adapter) => capability(adapter, "addressBook", "list its contacts")())
      const summary = await context.withStore((store, account) => syncPeople(store, account, people))
      context.renderer.result(summary)
      context.renderer.success(`${summary.added} new, ${summary.changed} changed, ${summary.known} people known`)
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
