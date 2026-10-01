import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type {
  Chat,
  Contact,
  Id,
  Member,
  Message,
  MessageHit,
  Page,
  Provider,
  Reactions,
  WindowedMessage,
} from "../domain/models.js"
import type { PeopleLookup } from "../resolve.js"
import { migrate } from "./migrations.js"
import { storeCapable } from "./open.js"
import { storePath } from "./path.js"
import * as accounts from "./sqlite/accounts.js"
import { backfillNormalized, pendingNormalization } from "./sqlite/backfill.js"
import * as chatQueries from "./sqlite/chats.js"
import * as identities from "./sqlite/identities.js"
import * as messageWrites from "./sqlite/messages.js"
import { openSqlite, type StoreContext } from "./sqlite/open.js"
import * as ranges from "./sqlite/ranges.js"
import * as reads from "./sqlite/reads.js"
import * as search from "./sqlite/search.js"
import * as sync from "./sqlite/sync.js"
import * as transcripts from "./sqlite/transcripts.js"

/** Which account of which messenger a call is about. */
export interface AccountKey {
  provider: Provider
  account: Id
}

/** How a message reached the store — `history`, `send`, `backfill`, `update`. Diagnostic. */
export type IngestedVia = string

export interface StoredHit extends MessageHit {
  locator: string
}

/** What a provider says about a person. `null` or absent never erases what was known. */
export interface PersonFacts {
  id: Id
  name: string | null
  username?: string | null
  isBot?: boolean | null
  description?: string | null
}

/**
 * Which messages `find` returns. At least `text` or `senders`.
 *
 * `together` keeps only the chats where **every** sender has a message in this store — written
 * there, as far as this copy knows, which is not the same as being a member.
 */
export interface MessageFilter {
  provider?: Provider
  account?: AccountKey
  /** Several accounts of `provider`, by native id — a read across some of them, never all by accident. */
  accounts?: Id[]
  senders?: Id[]
  together?: boolean
  text?: string
  /**
   * Tested against each stored message's text, newest first, in JavaScript — no index serves it, so
   * it reads the chat (or the account) until `limit` match. Not with `text` or `perChat`.
   */
  pattern?: RegExp
  /** Only this chat of the account; needs `account`. */
  chatId?: Id
  /** With `perChat`, the newest `limit` of each chat rather than of all of them together. */
  limit: number
  perChat?: boolean
}

export interface Delta {
  chats?: Chat[]
  people?: PersonFacts[]
  members?: Map<Id, Id[]>
  state?: Record<string, string>
}

export interface StoredChatFilter {
  query?: string
  kind?: Chat["kind"]
  unread?: boolean
}

export interface MessageStore {
  saveAccount(key: AccountKey, account: { name: string | null }): Promise<void>
  saveChats(key: AccountKey, chats: Chat[]): Promise<void>
  /** A scheduled message is not kept: it is not history yet. */
  /**
   * `seenAt` is when the messenger was asked: a message it still returned is not deleted, so a
   * tombstone older than that is lifted. A tombstone set after it stays — the deletion is newer.
   */
  saveMessages(
    key: AccountKey,
    chatId: Id,
    messages: Message[],
    options: { via: IngestedVia; seenAt?: number },
  ): Promise<void>
  /** Newest first. `query` matches three letters or more of a title; `unread` keeps chats with unread messages. */
  chats(key: AccountKey, window: { limit?: number; offset?: number } & StoredChatFilter): Promise<Page<Chat>>
  countChats(key: AccountKey, filter?: StoredChatFilter): Promise<number>
  /** Replaces who is in a chat with this list, whole: a person left out has left. */
  saveMembers(key: AccountKey, chatId: Id, memberIds: Id[]): Promise<void>
  /** Who is in a chat, by name, as the last list said; empty when no list was ever saved. */
  members(key: AccountKey, chatId: Id): Promise<Member[]>
  /** The chats a person is in, newest first — as far as the saved member lists go. */
  chatsWith(key: AccountKey, memberId: Id): Promise<Chat[]>
  /** What a sync remembered under `name` for this account, and when; a caller encodes a number itself. */
  syncState(key: AccountKey, name: string): Promise<{ value: string; at: string } | undefined>
  setSyncState(key: AccountKey, name: string, value: string): Promise<void>
  clearSyncState(key: AccountKey, name: string): Promise<void>
  /**
   * A catch-up's whole answer in one transaction, so a reader never sees half of it: chats, people,
   * each listed chat's members (replaced whole) and sync state such as a delta marker.
   */
  applyDelta(key: AccountKey, delta: Delta): Promise<void>
  /**
   * Takes the stretch of a chat at `anchor` for `forMs`; answers whether `holder` has it. Refused
   * while another holder's lease runs; the same holder renews its own.
   */
  claim(key: AccountKey, chatId: Id, anchor: string, holder: string, forMs: number): Promise<boolean>
  /** Gives the stretch back, if `holder` still has it. */
  release(key: AccountKey, chatId: Id, anchor: string, holder: string): Promise<void>
  /** What a voice message said, when it was heard before, and by what. */
  transcript(key: AccountKey, chatId: Id, messageId: Id): Promise<{ text: string; source: string } | undefined>
  /** Keeps a finished transcript; an empty one is not kept, so the message is heard again. */
  keepTranscript(key: AccountKey, chatId: Id, messageId: Id, text: string, source: string): Promise<void>
  /** Oldest to newest, like a provider's history page. */
  messages(key: AccountKey, chatId: Id, window: { limit: number; before?: Id; since?: string }): Promise<Page<Message>>
  /** How many stored messages the chat has, sent at `since` or later when it is given. */
  countMessages(key: AccountKey, chatId: Id, options?: { since?: string }): Promise<number>
  /**
   * By time rather than by id: `before` messages sent at `at` or earlier and `after` sent later,
   * oldest first. `around` answers the same question for a message id.
   */
  messagesWindow(key: AccountKey, chatId: Id, window: { at: string; before: number; after: number }): Promise<Message[]>
  /**
   * A stored message and its stored neighbours, oldest first, the one asked for with `anchor`. Until
   * backfill records which stretches are complete, a neighbour here is the nearest one kept, not
   * necessarily the next one sent.
   */
  around(
    key: AccountKey,
    chatId: Id,
    messageId: Id,
    window: { before: number; after: number },
  ): Promise<WindowedMessage[]>
  /**
   * One message by its id. Without `chatId` it is looked up across the account, which is enough
   * where ids are unique per account (MAX) and refused where two chats share one (Telegram).
   */
  message(key: AccountKey, messageId: Id, options?: { chatId?: Id }): Promise<Message | undefined>
  /**
   * Everything one account holds — its chats, messages, members, state, leases, transcripts and whom
   * it has seen — for `cache clear`. Other accounts, and identities they share, stay.
   */
  purge(key: AccountKey): Promise<void>
  /**
   * A tombstone, not a removal: the row stays, so a copy fetched before the deletion does not bring
   * the message back, and reads and search stop returning it. Its text goes — from the row, the
   * search copy, the edit history and the transcript. Only the messenger returning it again, when
   * asked after the deletion, lifts the tombstone (`saveMessages`' `seenAt`).
   */
  markDeleted(key: AccountKey, messageIds: Id[], options?: { chatId?: Id }): Promise<number>
  /** Newest first. At least three characters: a trigram index answers a shorter query with nothing. */
  search(query: string, options: { limit: number; account?: AccountKey }): Promise<Page<StoredHit>>
  /** Newest first — by text, by who wrote it, or both. */
  find(filter: MessageFilter): Promise<Page<StoredHit>>
  savePeople(key: AccountKey, people: PersonFacts[]): Promise<void>
  /**
   * The people this account has a one-to-one chat with — as far as the saved member lists go —
   * newest conversation first or by name. `query` matches three letters or more of a name or
   * username.
   */
  contacts(
    key: AccountKey,
    options: { order: "recent" | "name"; query?: string; limit: number; offset?: number },
  ): Promise<Page<Contact>>
  countContacts(key: AccountKey, options?: { query?: string }): Promise<number>
  /** Works out again when each contact was last written to, from their one-to-one chats. */
  refreshRecency(key: AccountKey): Promise<void>
  /** Everyone this provider's accounts have seen; with `account`, only who that account has seen. */
  people(provider: Provider, options?: { account?: Id; accounts?: Id[] }): Promise<PeopleLookup>
  /** A message's reactions as they are now; answers whether the message is held at all. */
  saveReactions(key: AccountKey, chatId: Id, messageId: Id, reactions: Reactions): Promise<boolean>
  /**
   * Records that every message from `from` to `to` (inclusive, by ordering key) is held, merging it
   * with the stretches it overlaps or touches. Answers the merged stretch.
   */
  markRange(key: AccountKey, chatId: Id, from: number, to: number): Promise<Range>
  /** Per chat that has messages: how many, the oldest and newest, and when the last one was stored. */
  chatStats(key: AccountKey, chatId?: Id): Promise<ChatStats[]>
  /** The stretches held completely, oldest first. */
  ranges(key: AccountKey, chatId: Id): Promise<Range[]>
  close(): Promise<void>
}

export interface ChatStats {
  chatId: Id
  title: string | null
  messages: number
  oldestAt: string | null
  newestAt: string | null
  lastStoredAt: string | null
}

export interface Range {
  from: number
  to: number
}

export interface StoreOptions {
  path?: string
  env?: NodeJS.ProcessEnv
  now?: () => number
}

/** About 40 ms of the first open (129k rows/s measured at 1M, 2026-09-30); Tab opens the store too. */
export const BACKFILL_ON_OPEN = 5_000

export const openStore = async ({ path, env, now = Date.now }: StoreOptions = {}): Promise<MessageStore> => {
  await storeCapable()
  const file = path ?? storePath(env)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  // Created before SQLite opens it: SQLite gives -wal and -shm the mode of the database file.
  writeFileSync(file, "", { flag: "a", mode: 0o600 })
  const { database, orm } = await openSqlite(file)
  try {
    migrate(database, { now })
    // A small file is filled on the spot; a larger one waits for `db migrate`, since nothing reads the copy yet.
    const pending = pendingNormalization(database)
    if (pending > 0 && pending <= BACKFILL_ON_OPEN) backfillNormalized(database)
  } catch (error) {
    database.close()
    throw error
  }
  return storeOver({ database, orm, now })
}

const storeOver = (context: StoreContext): MessageStore => {
  const { database } = context
  const inTransaction = (body: () => void): void => {
    database.exec("BEGIN IMMEDIATE")
    try {
      body()
      database.exec("COMMIT")
    } catch (error) {
      database.exec("ROLLBACK")
      throw error
    }
  }

  const accountPk = (key: AccountKey, name: string | null = null) => accounts.accountPk(context, key, name)
  const findAccountPk = (key: AccountKey) => accounts.findAccountPk(context, key)

  const findChatPk = (accountKey: number, chatId: Id) => chatQueries.findChatPk(context, accountKey, chatId)
  const chatKeyOf = (key: AccountKey, chatId: Id) => {
    const accountKey = findAccountPk(key)
    return accountKey === undefined ? undefined : findChatPk(accountKey, chatId)
  }
  const chatPkFor = (accountKey: number, chatId: Id) => chatQueries.chatPkFor(context, accountKey, chatId)

  const identityPk = (
    accountKey: number,
    provider: Provider,
    nativeId: Id,
    name: string | null,
    facts?: Omit<PersonFacts, "id" | "name">,
  ) => identities.identityPk(context, accountKey, provider, nativeId, name, facts)

  const upsertMessage = (
    key: AccountKey,
    accountKey: number,
    chatKey: number,
    message: Message,
    via: string,
    seenAt?: number,
  ) => messageWrites.upsertMessage(context, key, accountKey, chatKey, message, via, seenAt)

  const writeMembers = (key: AccountKey, accountKey: number, chatId: Id, memberIds: Id[]) =>
    chatQueries.writeMembers(context, key, accountKey, chatId, memberIds)

  const writeState = (accountKey: number, name: string, value: string) =>
    sync.writeState(context, accountKey, name, value)

  return {
    saveAccount: async (key, { name }) => {
      accountPk(key, name)
    },

    saveChats: async (key, list) =>
      inTransaction(() => {
        const accountKey = accountPk(key)
        for (const chat of list) chatQueries.upsertChat(context, accountKey, chat)
      }),

    saveMessages: async (key, chatId, messages, { via, seenAt }) =>
      inTransaction(() => {
        const accountKey = accountPk(key)
        const chatKey = chatPkFor(accountKey, chatId)
        for (const message of messages) {
          if (message.scheduledFor === undefined) upsertMessage(key, accountKey, chatKey, message, via, seenAt)
        }
      }),

    saveMembers: async (key, chatId, memberIds) =>
      inTransaction(() => writeMembers(key, accountPk(key), chatId, memberIds)),

    members: async (key, chatId) => {
      const accountKey = findAccountPk(key)
      const chatKey = accountKey === undefined ? undefined : findChatPk(accountKey, chatId)
      return chatKey === undefined ? [] : chatQueries.members(context, chatKey)
    },

    chatsWith: async (key, memberId) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined ? [] : chatQueries.chatsWith(context, accountKey, key, memberId)
    },

    syncState: async (key, name) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined ? undefined : sync.syncStateOf(context, accountKey, name)
    },

    setSyncState: async (key, name, value) => inTransaction(() => writeState(accountPk(key), name, value)),

    applyDelta: async (key, { chats = [], people = [], members = new Map(), state = {} }) =>
      inTransaction(() => {
        const accountKey = accountPk(key)
        for (const chat of chats) chatQueries.upsertChat(context, accountKey, chat)
        for (const person of people) identityPk(accountKey, key.provider, person.id, person.name, person)
        for (const [chatId, ids] of members) writeMembers(key, accountKey, chatId, ids)
        for (const [name, value] of Object.entries(state)) writeState(accountKey, name, value)
      }),

    clearSyncState: async (key, name) => {
      const accountKey = findAccountPk(key)
      if (accountKey !== undefined) sync.clearState(context, accountKey, name)
    },

    claim: async (key, chatId, anchor, holder, forMs) => {
      let taken = false
      inTransaction(() => {
        taken = sync.claim(context, chatPkFor(accountPk(key), chatId), anchor, holder, forMs)
      })
      return taken
    },

    release: async (key, chatId, anchor, holder) => {
      const accountKey = findAccountPk(key)
      const chatKey = accountKey === undefined ? undefined : findChatPk(accountKey, chatId)
      if (chatKey !== undefined) sync.release(context, chatKey, anchor, holder)
    },

    transcript: async (key, chatId, messageId) => {
      const accountKey = findAccountPk(key)
      const chatKey = accountKey === undefined ? undefined : findChatPk(accountKey, chatId)
      return chatKey === undefined ? undefined : transcripts.transcript(context, chatKey, messageId)
    },

    keepTranscript: async (key, chatId, messageId, text, source) => {
      if (text.trim() === "") return
      inTransaction(() =>
        transcripts.keepTranscript(context, chatPkFor(accountPk(key), chatId), messageId, text, source),
      )
    },

    chats: async (key, window) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined
        ? { items: [], hasMore: false }
        : chatQueries.listChats(context, accountKey, window)
    },

    countChats: async (key, filter = {}) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined ? 0 : chatQueries.countChats(context, accountKey, filter)
    },

    countMessages: async (key, chatId, { since } = {}) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? 0 : reads.countMessages(context, chatKey, since)
    },

    messagesWindow: async (key, chatId, window) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? [] : reads.messagesWindow(context, chatKey, window)
    },

    messages: async (key, chatId, window) => {
      const chatKey = chatKeyOf(key, chatId)
      return chatKey === undefined ? { items: [], hasMore: false } : reads.messagePage(context, chatKey, window)
    },

    around: async (key, chatId, messageId, window) => reads.around(context, chatKeyOf(key, chatId), messageId, window),

    message: async (key, messageId, { chatId } = {}) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined ? undefined : reads.message(context, accountKey, messageId, chatId)
    },

    markDeleted: async (key, messageIds, { chatId } = {}) => {
      const accountKey = findAccountPk(key)
      if (accountKey === undefined || messageIds.length === 0) return 0
      let changed = 0
      inTransaction(() => {
        changed = messageWrites.markDeleted(context, key, accountKey, messageIds, chatId)
      })
      return changed
    },

    purge: async (key) => {
      const accountKey = findAccountPk(key)
      if (accountKey === undefined) return
      inTransaction(() => accounts.purgeAccount(context, accountKey))
    },

    search: async (query, { limit, account }) =>
      search.find(context, { text: query, limit, ...(account ? { account } : {}) }),

    find: async (filter) => search.find(context, filter),

    contacts: async (key, options) => {
      const accountKey = findAccountPk(key)
      if (accountKey === undefined) return { items: [], hasMore: false }
      return identities.contacts(context, accountKey, key, options)
    },

    countContacts: async (key, { query } = {}) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined ? 0 : identities.countContacts(context, accountKey, key, query)
    },

    refreshRecency: async (key) => {
      const accountKey = findAccountPk(key)
      if (accountKey !== undefined) identities.refreshRecency(context, accountKey)
    },

    savePeople: async (key, people) =>
      inTransaction(() => {
        const accountKey = accountPk(key)
        for (const person of people) identityPk(accountKey, key.provider, person.id, person.name, person)
      }),

    people: async (provider, options = {}) => identities.people(context, provider, options),

    saveReactions: async (key, chatId, messageId, reactions) => {
      const accountKey = findAccountPk(key)
      const chatKey = accountKey === undefined ? undefined : findChatPk(accountKey, chatId)
      return chatKey === undefined ? false : messageWrites.saveReactions(context, chatKey, messageId, reactions)
    },

    markRange: async (key, chatId, from, to) => {
      let merged: Range = { from, to }
      inTransaction(() => {
        merged = ranges.markRange(context, chatPkFor(accountPk(key), chatId), from, to)
      })
      return merged
    },

    chatStats: async (key, chatId) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined ? [] : reads.chatStats(context, accountKey, chatId)
    },

    ranges: async (key, chatId) => {
      const accountKey = findAccountPk(key)
      const chatKey = accountKey === undefined ? undefined : findChatPk(accountKey, chatId)
      return chatKey === undefined ? [] : ranges.ranges(context, chatKey)
    },

    close: async () => database.close(),
  }
}
