import { CliError } from "@leemour/cli-core"
import { capability } from "../cli/messenger/port.js"
import type { Chat, Contact, Member, Page, PersonCard } from "../domain/models.js"
import type { PageWindow } from "./chats.js"
import type { ServiceDeps } from "./deps.js"

export interface ContactSync {
  added: number
  changed: number
  known: number
}

/**
 * A contact is somebody this account has a one-to-one chat with — a query over the chat list, never
 * a flag somebody maintains (max-cli `NEED-105`). So the list works offline from the stored chats.
 */
export interface PeopleService {
  list(options: { order: "recent" | "name"; search?: string } & PageWindow): Promise<Page<Contact>>
  show(person: string): Promise<PersonCard>
  /** `phone` as digits, parsed by the caller (`phoneOf`). */
  lookup(phone: string): Promise<Member>
  /** The whole contact list from the messenger into the store: what was new, what changed. */
  sync(): Promise<ContactSync>
}

export const peopleService = (deps: ServiceDeps): PeopleService => ({
  list: async (options) => {
    const chats = deps.offline
      ? (await (await deps.store()).chats(await deps.account(), {})).items
      : (await (await deps.connection()).chats({ offset: 0 })).items
    return contactsIn(chats, options)
  },

  show: async (person) => (await deps.connection()).contact(person),

  lookup: async (phone) => capability(await deps.connection(), "lookup", "find a person by phone")(phone),

  sync: async () => {
    if (deps.offline) {
      throw new CliError("validation_error", "`contacts sync` takes the list from the messenger; not with --offline")
    }
    const people = await capability(await deps.connection(), "addressBook", "list its contacts")()
    const store = await deps.store()
    const account = await deps.account()
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
  },
})

/** Digits, with the `+` and the spaces, dashes and brackets people type dropped. */
export const phoneOf = (typed: string): string => {
  const digits = typed.replace(/[\s()+-]/g, "")
  if (!/^\d{6,15}$/.test(digits)) {
    throw new CliError("validation_error", "that is not a phone number — digits, with a country code")
  }
  return digits
}

const contactsIn = (
  chats: readonly Chat[],
  { order, search, limit, offset }: { order: "recent" | "name"; search?: string } & PageWindow,
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
