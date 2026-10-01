import { CliError } from "@leemour/cli-core"
import { capability } from "../cli/messenger/port.js"
import type { Chat, Contact, Id, Member, Page, PersonCard, PhoneBookEntry } from "../domain/models.js"
import { pickPerson } from "../resolve.js"
import { guardedWrite, type Operated } from "../sends/guarded.js"
import { newOperationId } from "../sends/send-id.js"
import type { AccountKey, MessageStore } from "../store/store.js"
import type { PageWindow } from "./chats.js"
import { type ServiceDeps, storeIfOpen } from "./deps.js"

export interface ContactSync {
  added: number
  changed: number
  known: number
}

/**
 * A contact is somebody this account has a one-to-one chat with — a query over the chat list, never
 * a flag somebody maintains (max-cli `NEED-105`). Where the store holds who is in each one-to-one
 * chat, it answers; otherwise the dialogs themselves do, offline from the stored chats.
 */
export interface PeopleService {
  list(options: { order: "recent" | "name"; search?: string } & PageWindow): Promise<Page<Contact>>
  show(person: string): Promise<PersonCard>
  /** `phone` as digits, parsed by the caller (`phoneOf`). */
  lookup(phone: string): Promise<Member>
  /** The whole contact list from the messenger into the store: what was new, what changed. */
  sync(): Promise<ContactSync>
  add(person: string): Promise<Operated<{ person: Member }>>
  remove(person: string): Promise<Operated<{ personId: Id }>>
  block(person: string): Promise<Operated<{ personId: Id }>>
  unblock(person: string): Promise<Operated<{ personId: Id }>>
  rename(person: string, firstName: string, lastName?: string): Promise<Operated<{ person: Member }>>
  /** Only counts and the people recognised: never a number. */
  import(entries: PhoneBookEntry[]): Promise<Operated<{ sent: number; recognised: Member[] }>>
}

type ContactAction = "contact-add" | "contact-remove" | "contact-block" | "contact-unblock" | "contact-rename"

export const peopleService = (deps: ServiceDeps): PeopleService => {
  const online = async (command: string) => {
    if (deps.offline)
      throw new CliError("validation_error", `\`${command}\` changes the address book; not with --offline`)
    return deps.connection()
  }
  const change = async <T>(
    action: ContactAction,
    person: string,
    act: (connection: Awaited<ReturnType<ServiceDeps["connection"]>>, personId: Id) => Promise<T>,
  ): Promise<{ operationId: string; personId: Id; done: T }> => {
    const connection = await online(`contacts ${action.slice("contact-".length)}`)
    const [personId] = await capability(connection, "people", "find people")([person])
    const operationId = newOperationId()
    const done = await guardedWrite(deps.guard, { operationId, chatId: null, kind: "account", action }, () =>
      act(connection, personId as Id),
    )
    return { operationId, personId: personId as Id, done }
  }

  return {
    list: async (options) => {
      // The chats first: a messenger whose login brings its people writes them before the store is asked.
      const chats = deps.offline ? undefined : (await (await deps.connection()).chats({ offset: 0 })).items
      const held = deps.offline ? { store: await deps.store(), account: await deps.account() } : await storeIfOpen(deps)
      if (held && (await held.store.countContacts(held.account)) > 0)
        return storedContacts(held.store, held.account, options)
      return contactsIn(chats ?? (await (await deps.store()).chats(await deps.account(), {})).items, options)
    },

    show: async (person) => {
      if (deps.offline) {
        const store = await deps.store()
        const account = await deps.account()
        const found = pickPerson(person, await store.people(account.provider, { account: account.account }))
        return { ...found, chats: await sharedChats(store, account, found.id) }
      }
      const card = await (await deps.connection()).contact(person)
      if (card.chats.length > 0) return card
      const held = await storeIfOpen(deps)
      return held ? { ...card, chats: await sharedChats(held.store, held.account, card.id) } : card
    },

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
      return {
        added,
        changed,
        known: (await store.people(account.provider, { account: account.account })).all().length,
      }
    },

    add: async (person) => {
      const { operationId, done } = await change("contact-add", person, (connection, id) =>
        capability(connection, "addContact", "add a contact")(id),
      )
      return { operationId, person: done }
    },

    remove: async (person) => {
      const { operationId, personId } = await change("contact-remove", person, (connection, id) =>
        capability(connection, "removeContact", "remove a contact")(id),
      )
      return { operationId, personId }
    },

    block: async (person) => {
      const { operationId, personId } = await change("contact-block", person, (connection, id) =>
        capability(connection, "block", "block a person")(id),
      )
      return { operationId, personId }
    },

    unblock: async (person) => {
      const { operationId, personId } = await change("contact-unblock", person, (connection, id) =>
        capability(connection, "unblock", "unblock a person")(id),
      )
      return { operationId, personId }
    },

    rename: async (person, firstName, lastName) => {
      if (firstName.trim() === "") throw new CliError("validation_error", "a name cannot be empty")
      const { operationId, done } = await change("contact-rename", person, (connection, id) =>
        capability(connection, "renameContact", "rename a contact")(id, firstName.trim(), lastName?.trim()),
      )
      return { operationId, person: done }
    },

    import: async (entries) => {
      if (entries.length === 0) throw new CliError("validation_error", "the file names nobody")
      const connection = await online("contacts import")
      const importing = capability(connection, "importContacts", "import contacts")
      const operationId = newOperationId()
      const recognised = await guardedWrite(
        deps.guard,
        { operationId, chatId: null, kind: "account", action: "contact-import", count: entries.length },
        () => importing(entries),
      )
      return { operationId, sent: entries.length, recognised }
    },
  }
}

/** Digits, with the `+` and the spaces, dashes and brackets people type dropped. */
export const phoneOf = (typed: string): string => {
  const digits = typed.replace(/[\s()+-]/g, "")
  if (!/^\d{6,15}$/.test(digits)) {
    throw new CliError("validation_error", "that is not a phone number — digits, with a country code")
  }
  return digits
}

const storedContacts = async (
  store: MessageStore,
  account: AccountKey,
  { order, search, limit, offset }: { order: "recent" | "name"; search?: string } & PageWindow,
): Promise<Page<Contact>> => {
  // Chats saved since the last refresh may have moved someone up; the order is worked out again here.
  if (order === "recent") await store.refreshRecency(account)
  const query = search?.trim() || undefined
  return store.contacts(account, {
    order,
    ...(query === undefined ? {} : { query }),
    limit: limit ?? (await store.countContacts(account, query === undefined ? {} : { query })),
    offset,
  })
}

const sharedChats = async (store: MessageStore, account: AccountKey, personId: string) =>
  (await store.chatsWith(account, personId)).map(({ id, title, kind, lastMessageAt }) => ({
    id,
    title,
    kind,
    lastMessageAt,
  }))

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
