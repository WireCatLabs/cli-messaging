import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { CliError } from "@leemour/cli-core"
import { formatLocator } from "../domain/locator.js"
import type {
  Attachment,
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
import type { SqlValue } from "./driver.js"
import { migrate } from "./migrations.js"
import { storePath } from "./path.js"
import * as accounts from "./sqlite/accounts.js"
import { backfillNormalized, pendingNormalization } from "./sqlite/backfill.js"
import * as chatQueries from "./sqlite/chats.js"
import * as identities from "./sqlite/identities.js"
import * as messageWrites from "./sqlite/messages.js"
import { openSqlite, type StoreContext } from "./sqlite/open.js"
import * as ranges from "./sqlite/ranges.js"
import * as sync from "./sqlite/sync.js"
import * as transcripts from "./sqlite/transcripts.js"
import { parsed, present, toIso, toMs } from "./sqlite/values.js"

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

/** Telegram's chat types that number their messages themselves, not per account. */
const OWN_NUMBERING = "('channel', 'supergroup', 'gigagroup', 'monoforum')"

const storeOver = (context: StoreContext): MessageStore => {
  const { database } = context
  const one = (sql: string, ...parameters: SqlValue[]) => database.prepare(sql).get(...parameters)
  const all = (sql: string, ...parameters: SqlValue[]) => database.prepare(sql).all(...parameters)

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

  const attachmentsOf = (rows: Record<string, unknown>[]): Map<number, Attachment[]> => {
    const byMessage = new Map<number, Attachment[]>()
    if (rows.length === 0) return byMessage
    const keys = rows.map((row) => Number(row.pk))
    for (const row of all(
      `SELECT * FROM attachments WHERE message_pk IN (${keys.map(() => "?").join(", ")})
       ORDER BY message_pk, position`,
      ...keys,
    )) {
      const list = byMessage.get(Number(row.message_pk)) ?? []
      list.push(toAttachment(row))
      byMessage.set(Number(row.message_pk), list)
    }
    return byMessage
  }

  const toMessages = (rows: Record<string, unknown>[]): Message[] => {
    const attachments = attachmentsOf(rows)
    return rows.map((row) => toMessage(row, attachments.get(Number(row.pk)) ?? []))
  }

  const find = ({
    provider,
    account,
    accounts,
    senders,
    together = false,
    text,
    pattern,
    chatId,
    limit,
    perChat = false,
  }: MessageFilter): Page<StoredHit> => {
    const trimmed = pattern ? undefined : text?.trim()
    if (trimmed !== undefined && [...trimmed].length < 3) {
      throw new CliError("validation_error", "search needs at least three characters")
    }
    if (pattern && perChat) throw new CliError("validation_error", "a pattern search is not per chat")
    if (!trimmed && !pattern && !senders?.length) {
      throw new CliError("validation_error", "say what to find: some text, or who wrote it")
    }
    const conditions = ["m.deleted_at IS NULL"]
    const parameters: SqlValue[] = []
    if (trimmed) {
      conditions.push("m.pk IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)")
      parameters.push(wordsOf(trimmed))
    }
    const scopeProvider = account?.provider ?? provider
    if (accounts && scopeProvider === undefined) {
      throw new CliError("validation_error", "a read across accounts names their provider")
    }
    if (scopeProvider !== undefined) {
      conditions.push("a.provider = ?")
      parameters.push(scopeProvider)
    }
    if (account) {
      conditions.push("a.native_id = ?")
      parameters.push(account.account)
    }
    if (accounts) {
      conditions.push(`a.native_id IN (${accounts.map(() => "?").join(", ") || "NULL"})`)
      parameters.push(...accounts)
    }
    if (chatId !== undefined) {
      conditions.push("c.native_id = ?")
      parameters.push(chatId)
    }
    if (senders?.length) {
      const ids = [...new Set(senders)]
      const marks = ids.map(() => "?").join(", ")
      conditions.push(`i.provider = a.provider AND i.native_id IN (${marks})`)
      parameters.push(...ids)
      if (together) {
        conditions.push(`m.chat_pk IN (
          SELECT m2.chat_pk FROM messages m2 JOIN identities i2 ON i2.pk = m2.sender_identity_pk
          WHERE m2.deleted_at IS NULL AND ${scopeProvider === undefined ? "i2.provider = i.provider" : "i2.provider = ?"}
            AND i2.native_id IN (${marks})
          GROUP BY m2.chat_pk HAVING count(DISTINCT i2.native_id) = ?)`)
        parameters.push(...(scopeProvider === undefined ? [] : [scopeProvider]), ...ids, ids.length)
      }
    }
    const matching = `SELECT ${MESSAGE_COLUMNS}, c.title AS chat_title, a.provider AS provider,
         a.native_id AS account_native_id
         ${perChat ? ", row_number() OVER (PARTITION BY m.chat_pk ORDER BY m.sent_at DESC, m.pk DESC) AS chat_rank" : ""}
       FROM messages m ${MESSAGE_JOINS} JOIN accounts a ON a.pk = m.account_pk
       WHERE ${conditions.join(" AND ")}`
    const rows = pattern
      ? scan(matching, parameters, pattern, limit + 1)
      : perChat
        ? all(
            `SELECT * FROM (${matching}) WHERE chat_rank <= ? ORDER BY sent_at DESC, pk DESC`,
            ...parameters,
            limit + 1,
          )
        : all(`${matching} ORDER BY m.sent_at DESC, m.pk DESC LIMIT ?`, ...parameters, limit + 1)
    const page = perChat ? rows.filter((row) => Number(row.chat_rank) <= limit) : rows.slice(0, limit)
    const messages = toMessages(page)
    return {
      items: page.map((row, index) => {
        const message = messages[index] as Message
        return {
          ...message,
          chatTitle: (row.chat_title as string | null) ?? null,
          locator: formatLocator({
            provider: String(row.provider),
            account: String(row.account_native_id),
            chat: message.chatId,
            message: message.id,
          }),
        }
      }),
      hasMore: rows.length > page.length,
    }
  }

  /** Newest first, a chunk at a time, until `wanted` rows match or the rows run out. */
  const scan = (matching: string, parameters: SqlValue[], pattern: RegExp, wanted: number) => {
    const found: Record<string, unknown>[] = []
    let after: [number, number] | undefined
    while (found.length < wanted) {
      const chunk = all(
        `${matching} ${after ? "AND (m.sent_at, m.pk) < (?, ?)" : ""} ORDER BY m.sent_at DESC, m.pk DESC LIMIT 500`,
        ...parameters,
        ...(after ?? []),
      )
      for (const row of chunk) {
        pattern.lastIndex = 0
        if (pattern.test(String(row.text ?? ""))) found.push(row)
        if (found.length === wanted) break
      }
      const last = chunk.at(-1)
      if (chunk.length < 500 || !last) break
      after = [Number(last.sent_at), Number(last.pk)]
    }
    return found
  }

  const writeMembers = (key: AccountKey, accountKey: number, chatId: Id, memberIds: Id[]) =>
    chatQueries.writeMembers(context, key, accountKey, chatId, memberIds)

  const writeState = (accountKey: number, name: string, value: string) =>
    sync.writeState(context, accountKey, name, value)

  const tombstone = (pk: number) => messageWrites.tombstone(context, pk)

  const MESSAGE_COLUMNS = `m.*, c.native_id AS chat_native_id, i.native_id AS sender_native_id`
  const MESSAGE_JOINS = `JOIN chats c ON c.pk = m.chat_pk LEFT JOIN identities i ON i.pk = m.sender_identity_pk`

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
      const accountKey = findAccountPk(key)
      const chatKey = accountKey === undefined ? undefined : findChatPk(accountKey, chatId)
      if (chatKey === undefined) return 0
      return Number(
        one(
          `SELECT count(*) AS n FROM messages WHERE chat_pk = ? AND deleted_at IS NULL AND sent_at >= ?`,
          chatKey,
          since === undefined ? Number.MIN_SAFE_INTEGER : (toMs(since) as number),
        )?.n,
      )
    },

    messagesWindow: async (key, chatId, { at, before, after }) => {
      const accountKey = findAccountPk(key)
      const chatKey = accountKey === undefined ? undefined : findChatPk(accountKey, chatId)
      if (chatKey === undefined) return []
      const moment = toMs(at) as number
      const earlier = all(
        `SELECT ${MESSAGE_COLUMNS} FROM messages m ${MESSAGE_JOINS}
         WHERE m.chat_pk = ? AND m.deleted_at IS NULL AND m.sent_at <= ?
         ORDER BY m.sent_at DESC, m.pk DESC LIMIT ?`,
        chatKey,
        moment,
        before,
      )
      const later = all(
        `SELECT ${MESSAGE_COLUMNS} FROM messages m ${MESSAGE_JOINS}
         WHERE m.chat_pk = ? AND m.deleted_at IS NULL AND m.sent_at > ?
         ORDER BY m.sent_at, m.pk LIMIT ?`,
        chatKey,
        moment,
        after,
      )
      return toMessages([...earlier.reverse(), ...later])
    },

    messages: async (key, chatId, { limit, before, since }) => {
      const accountKey = findAccountPk(key)
      const chatKey = accountKey === undefined ? undefined : findChatPk(accountKey, chatId)
      if (chatKey === undefined) return { items: [], hasMore: false }
      const anchor =
        before === undefined
          ? undefined
          : one("SELECT sent_at, pk FROM messages WHERE chat_pk = ? AND native_id = ?", chatKey, before)
      if (before !== undefined && !anchor) {
        throw new CliError("not_found", `message ${before} is not in the local copy of this chat`)
      }
      const rows = all(
        `SELECT ${MESSAGE_COLUMNS} FROM messages m ${MESSAGE_JOINS}
         WHERE m.chat_pk = ? AND m.deleted_at IS NULL ${anchor ? "AND (m.sent_at, m.pk) < (?, ?)" : ""}
           ${since === undefined ? "" : "AND m.sent_at >= ?"}
         ORDER BY m.sent_at DESC, m.pk DESC LIMIT ?`,
        chatKey,
        ...(anchor ? [anchor.sent_at as number, anchor.pk as number] : []),
        ...(since === undefined ? [] : [toMs(since) as number]),
        limit + 1,
      )
      return { items: toMessages(rows.slice(0, limit)).reverse(), hasMore: rows.length > limit }
    },

    around: async (key, chatId, messageId, { before, after }) => {
      const accountKey = findAccountPk(key)
      const chatKey = accountKey === undefined ? undefined : findChatPk(accountKey, chatId)
      const anchor =
        chatKey === undefined
          ? undefined
          : one(
              `SELECT ${MESSAGE_COLUMNS} FROM messages m ${MESSAGE_JOINS}
               WHERE m.chat_pk = ? AND m.native_id = ? AND m.deleted_at IS NULL`,
              chatKey,
              messageId,
            )
      if (chatKey === undefined || !anchor) {
        throw new CliError("not_found", `message ${messageId} is not in the local copy of this chat`)
      }
      const side = (direction: "<" | ">", count: number) =>
        count === 0
          ? []
          : all(
              `SELECT ${MESSAGE_COLUMNS} FROM messages m ${MESSAGE_JOINS}
               WHERE m.chat_pk = ? AND m.deleted_at IS NULL AND (m.sent_at, m.pk) ${direction} (?, ?)
               ORDER BY m.sent_at ${direction === "<" ? "DESC" : "ASC"}, m.pk ${direction === "<" ? "DESC" : "ASC"}
               LIMIT ?`,
              chatKey,
              anchor.sent_at as number,
              anchor.pk as number,
              count,
            )
      const rows = [...side("<", before).reverse(), anchor, ...side(">", after)]
      return toMessages(rows).map((message, index) => (rows[index] === anchor ? { ...message, anchor: true } : message))
    },

    message: async (key, messageId, { chatId } = {}) => {
      const accountKey = findAccountPk(key)
      if (accountKey === undefined) return undefined
      const rows = all(
        `SELECT ${MESSAGE_COLUMNS} FROM messages m ${MESSAGE_JOINS}
         WHERE m.account_pk = ? AND m.native_id = ? AND m.deleted_at IS NULL ${chatId === undefined ? "" : "AND c.native_id = ?"}
         LIMIT 2`,
        accountKey,
        messageId,
        ...(chatId === undefined ? [] : [chatId]),
      )
      if (rows.length > 1) {
        throw new CliError("validation_error", `message ${messageId} is in more than one chat — name the chat`)
      }
      return toMessages(rows)[0]
    },

    markDeleted: async (key, messageIds, { chatId } = {}) => {
      const accountKey = findAccountPk(key)
      if (accountKey === undefined || messageIds.length === 0) return 0
      // A Telegram chat stored only by its id, from a message seen before the chat, has no kind yet —
      // but a channel's or a supergroup's id is marked `-100…`, which says enough.
      const stubs = key.provider === "telegram" ? "AND NOT (c.kind = 'unknown' AND c.native_id LIKE '-100%')" : ""
      let changed = 0
      inTransaction(() => {
        for (const messageId of messageIds) {
          if (chatId !== undefined) {
            const found = one(
              `SELECT pk FROM messages WHERE account_pk = ? AND native_id = ? AND deleted_at IS NULL
               AND chat_pk = (SELECT pk FROM chats WHERE account_pk = ? AND native_id = ?)`,
              accountKey,
              messageId,
              accountKey,
              chatId,
            )
            if (found) changed += tombstone(Number(found.pk))
            continue
          }
          // Telegram names a deletion without its chat only where ids count per account; a channel or
          // supergroup numbers its own, so the same id there is another message. Two candidates left
          // means the id is ambiguous, and a missed tombstone is better than a wrong one.
          const candidates = all(
            `SELECT m.pk FROM messages m JOIN chats c ON c.pk = m.chat_pk
             WHERE m.account_pk = ? AND m.native_id = ? AND m.deleted_at IS NULL AND c.kind <> 'channel' ${stubs}
               AND coalesce(json_extract(c.provider_metadata, '$.chatType'), '') NOT IN ${OWN_NUMBERING}`,
            accountKey,
            messageId,
          )
          if (candidates.length !== 1) continue
          changed += tombstone(Number(candidates[0]?.pk))
        }
      })
      return changed
    },

    purge: async (key) => {
      const accountKey = findAccountPk(key)
      if (accountKey === undefined) return
      inTransaction(() => accounts.purgeAccount(context, accountKey))
    },

    search: async (query, { limit, account }) => find({ text: query, limit, ...(account ? { account } : {}) }),

    find: async (filter) => find(filter),

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
      if (accountKey === undefined) return []
      return all(
        `SELECT c.native_id, c.title, count(m.pk) AS messages, min(m.sent_at) AS oldest, max(m.sent_at) AS newest,
                max(m.ingested_at) AS stored
         FROM chats c JOIN messages m ON m.chat_pk = c.pk AND m.deleted_at IS NULL
         WHERE c.account_pk = ? ${chatId === undefined ? "" : "AND c.native_id = ?"}
         GROUP BY c.pk ORDER BY newest DESC`,
        accountKey,
        ...(chatId === undefined ? [] : [chatId]),
      ).map((row) => ({
        chatId: String(row.native_id),
        title: (row.title as string | null) ?? null,
        messages: Number(row.messages),
        oldestAt: toIso(row.oldest),
        newestAt: toIso(row.newest),
        lastStoredAt: toIso(row.stored),
      }))
    },

    ranges: async (key, chatId) => {
      const accountKey = findAccountPk(key)
      const chatKey = accountKey === undefined ? undefined : findChatPk(accountKey, chatId)
      return chatKey === undefined ? [] : ranges.ranges(context, chatKey)
    },

    close: async () => database.close(),
  }
}

const toAttachment = (row: Record<string, unknown>): Attachment =>
  ({
    kind: String(row.kind),
    ...present({
      url: row.url,
      width: row.width,
      height: row.height,
      title: row.title,
      name: row.name,
      size: row.size,
      mime: row.mime,
      duration: row.duration,
      providerRef: parsed(row.provider_ref),
    }),
  }) as Attachment

const toMessage = (row: Record<string, unknown>, attachments: Attachment[]): Message => {
  const senderChat = row.sender_chat_native_id as string | null
  return {
    id: String(row.native_id),
    chatId: String(row.chat_native_id),
    senderId: senderChat ?? (row.sender_native_id as string | null) ?? null,
    senderName: (row.sender_name as string | null) ?? null,
    ...(senderChat ? { senderIsChat: true } : {}),
    timestamp: toIso(row.sent_at) as string,
    editedAt: toIso(row.edited_at),
    text: String(row.text),
    outgoing: row.outgoing === null ? null : row.outgoing === 1,
    attachments,
    replyTo: parsed(row.reply_to) ?? null,
    ...present({ replyToId: row.reply_to_native_id }),
    forwardedFrom: parsed(row.forward) ?? null,
    ...present({ threadId: row.thread_native_id }),
    reactions: parsed(row.reactions) ?? null,
    ...present({ providerMetadata: parsed(row.provider_metadata) }),
  } as Message
}

/**
 * Every word as the beginning of a word, all of them required: `квартир` finds квартира and
 * квартиру, which an index of whole words would not. Punctuation separates words, as the index does.
 */
/** Every word of three characters or more, found anywhere inside the text; a trigram index cannot match a shorter one. */
const wordsOf = (text: string): string => {
  const words = (text.match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => [...word].length >= 3)
  if (words.length === 0) throw new CliError("validation_error", "search needs a word of three letters or more")
  return words.map((word) => `"${word}"`).join(" ")
}
