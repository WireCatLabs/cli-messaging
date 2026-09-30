import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { CliError } from "@leemour/cli-core"
import { formatLocator } from "../domain/locator.js"
import type {
  Attachment,
  Chat,
  Contact,
  Id,
  Message,
  MessageHit,
  Page,
  Provider,
  Reactions,
  WindowedMessage,
} from "../domain/models.js"
import type { PeopleLookup } from "../resolve.js"
import type { CacheDatabase, SqlValue } from "./driver.js"
import { migrate } from "./migrations.js"
import { NORMALIZER_VERSION, normalize } from "./normalize.js"
import { openCache } from "./open.js"
import { storePath } from "./path.js"
import { backfillNormalized, pendingNormalization } from "./sqlite/backfill.js"
import { ulid } from "./ulid.js"

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
  chats(key: AccountKey, window: { limit?: number; offset?: number }): Promise<Page<Chat>>
  /** Oldest to newest, like a provider's history page. */
  messages(key: AccountKey, chatId: Id, window: { limit: number; before?: Id }): Promise<Page<Message>>
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
  /** A tombstone, not a removal: the row stays, and reads and search stop returning it. */
  markDeleted(key: AccountKey, messageIds: Id[], options?: { chatId?: Id }): Promise<number>
  /** Newest first. At least three characters: a trigram index answers a shorter query with nothing. */
  search(query: string, options: { limit: number; account?: AccountKey }): Promise<Page<StoredHit>>
  /** Newest first — by text, by who wrote it, or both. */
  find(filter: MessageFilter): Promise<Page<StoredHit>>
  savePeople(key: AccountKey, people: PersonFacts[]): Promise<void>
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
  const database = await openCache(file)
  try {
    migrate(database, { now })
    // A small file is filled on the spot; a larger one waits for `db migrate`, since nothing reads the copy yet.
    const pending = pendingNormalization(database)
    if (pending > 0 && pending <= BACKFILL_ON_OPEN) backfillNormalized(database)
  } catch (error) {
    database.close()
    throw error
  }
  return storeOver(database, now)
}

/** Telegram's chat types that number their messages themselves, not per account. */
const OWN_NUMBERING = "('channel', 'supergroup', 'gigagroup', 'monoforum')"

const storeOver = (database: CacheDatabase, now: () => number): MessageStore => {
  const one = (sql: string, ...parameters: SqlValue[]) => database.prepare(sql).get(...parameters)
  const all = (sql: string, ...parameters: SqlValue[]) => database.prepare(sql).all(...parameters)
  const run = (sql: string, ...parameters: SqlValue[]) => database.prepare(sql).run(...parameters)

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

  const accountPk = ({ provider, account }: AccountKey, name: string | null = null): number =>
    Number(
      one(
        `INSERT INTO accounts (provider, native_id, name, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (provider, native_id) DO UPDATE SET name = coalesce(excluded.name, accounts.name)
         RETURNING pk`,
        provider,
        account,
        name,
        now(),
      )?.pk,
    )

  const findAccountPk = ({ provider, account }: AccountKey): number | undefined => {
    const row = one("SELECT pk FROM accounts WHERE provider = ? AND native_id = ?", provider, account)
    return row ? Number(row.pk) : undefined
  }

  const findChatPk = (accountKey: number, chatId: Id): number | undefined => {
    const row = one("SELECT pk FROM chats WHERE account_pk = ? AND native_id = ?", accountKey, chatId)
    return row ? Number(row.pk) : undefined
  }

  const upsertChat = (accountKey: number, chat: Chat): void => {
    run(
      `INSERT INTO chats (account_pk, native_id, kind, title, unread_count, last_message_at, participants_count,
                          provider_metadata, membership_state, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (account_pk, native_id) DO UPDATE SET
         kind = excluded.kind, title = excluded.title, unread_count = excluded.unread_count,
         last_message_at = excluded.last_message_at, participants_count = excluded.participants_count,
         provider_metadata = excluded.provider_metadata,
         membership_state = coalesce(excluded.membership_state, chats.membership_state),
         updated_at = excluded.updated_at`,
      accountKey,
      chat.id,
      chat.kind,
      chat.title,
      chat.unreadCount,
      toMs(chat.lastMessageAt),
      chat.participantsCount,
      json(chat.providerMetadata),
      chat.membershipState ?? null,
      now(),
    )
  }

  /** A chat known only from its messages, until the chat list names it. */
  const chatPkFor = (accountKey: number, chatId: Id): number =>
    findChatPk(accountKey, chatId) ??
    Number(
      one(
        "INSERT INTO chats (account_pk, native_id, kind, updated_at) VALUES (?, ?, 'unknown', ?) RETURNING pk",
        accountKey,
        chatId,
        now(),
      )?.pk,
    )

  /** An identity as `accountKey` saw it — recorded as seen by that account, so reads stay per account. */
  const identityPk = (
    accountKey: number,
    provider: Provider,
    nativeId: Id,
    name: string | null,
    facts: Omit<PersonFacts, "id" | "name"> = {},
  ): number => {
    const identity = identityOf(provider, nativeId, name, facts)
    run(
      "INSERT OR IGNORE INTO account_identities (account_pk, identity_pk, first_seen_at) VALUES (?, ?, ?)",
      accountKey,
      identity,
      now(),
    )
    return identity
  }

  /** Every new identity gets its own person; linking two is a later, recorded act. */
  const identityOf = (
    provider: Provider,
    nativeId: Id,
    name: string | null,
    facts: Omit<PersonFacts, "id" | "name"> = {},
  ): number => {
    const found = one(
      "SELECT pk, name, username, is_bot FROM identities WHERE provider = ? AND native_id = ?",
      provider,
      nativeId,
    )
    if (found) {
      const username = facts.username ?? found.username ?? null
      const isBot = facts.isBot === undefined || facts.isBot === null ? (found.is_bot ?? null) : Number(facts.isBot)
      const newName = name ?? found.name ?? null
      // Only on a real change: the search trigger rewrites the index row on every update of `name`.
      if (newName !== found.name || username !== found.username || isBot !== found.is_bot) {
        run(
          "UPDATE identities SET name = ?, username = ?, is_bot = ?, updated_at = ? WHERE pk = ?",
          newName as SqlValue,
          username as SqlValue,
          isBot as SqlValue,
          now(),
          Number(found.pk),
        )
      }
      return Number(found.pk)
    }
    const at = now()
    const identity = Number(
      one(
        `INSERT INTO identities (provider, native_id, name, username, is_bot, first_seen_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING pk`,
        provider,
        nativeId,
        name,
        facts.username ?? null,
        facts.isBot === undefined || facts.isBot === null ? null : Number(facts.isBot),
        at,
        at,
      )?.pk,
    )
    const person = Number(
      one(
        "INSERT INTO persons (uid, name, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING pk",
        ulid(at),
        name,
        at,
        at,
      )?.pk,
    )
    run(
      `INSERT INTO identity_links (identity_pk, person_pk, method, confidence, linked_at, linked_by)
       VALUES (?, ?, 'initial', 1, ?, 'ingest')`,
      identity,
      person,
      at,
    )
    run(
      `INSERT INTO identity_link_events (identity_pk, from_person_pk, to_person_pk, method, at, by)
       VALUES (?, NULL, ?, 'initial', ?, 'ingest')`,
      identity,
      person,
      at,
    )
    return identity
  }

  const upsertMessage = (
    key: AccountKey,
    accountKey: number,
    chatKey: number,
    message: Message,
    via: string,
    seenAt?: number,
  ) => {
    const sender =
      message.senderId === null || message.senderIsChat
        ? null
        : identityPk(accountKey, key.provider, message.senderId, message.senderName)
    const fields = {
      thread_native_id: message.threadId ?? null,
      sender_identity_pk: sender,
      sender_chat_native_id: message.senderIsChat ? message.senderId : null,
      sender_name: message.senderName,
      sent_at: toMs(message.timestamp) ?? 0,
      edited_at: toMs(message.editedAt),
      reply_to_native_id: message.replyToId ?? message.replyTo?.id ?? null,
      reply_to: json(message.replyTo ?? undefined),
      forward: json(message.forwardedFrom ?? undefined),
      outgoing: message.outgoing === null ? null : Number(message.outgoing),
      reactions: json(message.reactions ?? undefined),
      provider_metadata: json(message.providerMetadata),
    } satisfies Record<string, SqlValue>

    const found = one(
      "SELECT pk, text, edited_at, deleted_at FROM messages WHERE chat_pk = ? AND native_id = ?",
      chatKey,
      message.id,
    )
    // A deleted message gets no second copy of its text (the owner's ruling: deletion leaves no text).
    const revived = found?.deleted_at != null && seenAt !== undefined && Number(found.deleted_at) < seenAt
    const normalized: Record<string, SqlValue> = found?.deleted_at == null || revived ? searchable(message.text) : {}
    let pk: number
    if (!found) {
      const columns = [...Object.keys(fields), ...Object.keys(normalized)]
      pk = Number(
        one(
          `INSERT INTO messages (chat_pk, account_pk, native_id, text, ingested_at, ingested_via, ${columns.join(", ")})
           VALUES (?, ?, ?, ?, ?, ?, ${columns.map(() => "?").join(", ")}) RETURNING pk`,
          chatKey,
          accountKey,
          message.id,
          message.text,
          now(),
          via,
          ...Object.values(fields),
          ...Object.values(normalized),
        )?.pk,
      )
    } else {
      pk = Number(found.pk)
      // A copy that knows less — no reactions asked for, no quote sent, no sender — never erases what we had.
      const assignments = [...Object.keys(fields), ...Object.keys(normalized)].map(
        (column) => `${column} = coalesce(?, ${column})`,
      )
      run(
        `UPDATE messages SET ${assignments.join(", ")} WHERE pk = ?`,
        ...Object.values(fields),
        ...Object.values(normalized),
        pk,
      )
      if (found.text !== message.text) {
        run(
          "INSERT INTO message_revisions (message_pk, text, edited_at, captured_at) VALUES (?, ?, ?, ?)",
          pk,
          String(found.text),
          (found.edited_at as number | null) ?? null,
          now(),
        )
        run("UPDATE messages SET text = ? WHERE pk = ?", message.text, pk)
      }
      if (revived) run("UPDATE messages SET deleted_at = NULL WHERE pk = ?", pk)
    }

    message.attachments.forEach((attachment, position) => {
      // Upserted by position, never replaced: a later fetch must not lose where the bytes were saved.
      run(
        `INSERT INTO attachments (message_pk, position, kind, mime, name, title, url, size, width, height, duration,
                                  provider_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (message_pk, position) DO UPDATE SET
           kind = excluded.kind, mime = excluded.mime, name = excluded.name, title = excluded.title,
           url = excluded.url, size = excluded.size, width = excluded.width, height = excluded.height,
           duration = excluded.duration, provider_ref = excluded.provider_ref`,
        pk,
        position,
        attachment.kind,
        attachment.mime ?? null,
        attachment.name ?? null,
        attachment.title ?? null,
        attachment.url ?? null,
        attachment.size ?? null,
        attachment.width ?? null,
        attachment.height ?? null,
        attachment.duration ?? null,
        json(attachment.providerRef),
      )
    })
  }

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

  const MESSAGE_COLUMNS = `m.*, c.native_id AS chat_native_id, i.native_id AS sender_native_id`
  const MESSAGE_JOINS = `JOIN chats c ON c.pk = m.chat_pk LEFT JOIN identities i ON i.pk = m.sender_identity_pk`

  return {
    saveAccount: async (key, { name }) => {
      accountPk(key, name)
    },

    saveChats: async (key, chats) =>
      inTransaction(() => {
        const accountKey = accountPk(key)
        for (const chat of chats) upsertChat(accountKey, chat)
      }),

    saveMessages: async (key, chatId, messages, { via, seenAt }) =>
      inTransaction(() => {
        const accountKey = accountPk(key)
        const chatKey = chatPkFor(accountKey, chatId)
        for (const message of messages) {
          if (message.scheduledFor === undefined) upsertMessage(key, accountKey, chatKey, message, via, seenAt)
        }
      }),

    chats: async (key, { limit, offset = 0 }) => {
      const accountKey = findAccountPk(key)
      if (accountKey === undefined) return { items: [], hasMore: false }
      const rows = all(
        `SELECT * FROM chats WHERE account_pk = ? ORDER BY last_message_at DESC NULLS LAST, pk LIMIT ? OFFSET ?`,
        accountKey,
        limit === undefined ? -1 : limit + 1,
        offset,
      )
      const hasMore = limit !== undefined && rows.length > limit
      return { items: rows.slice(0, limit).map(toChat), hasMore }
    },

    messages: async (key, chatId, { limit, before }) => {
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
         ORDER BY m.sent_at DESC, m.pk DESC LIMIT ?`,
        chatKey,
        ...(anchor ? [anchor.sent_at as number, anchor.pk as number] : []),
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
            changed += run(
              `UPDATE messages SET deleted_at = ? WHERE account_pk = ? AND native_id = ? AND deleted_at IS NULL
               AND chat_pk = (SELECT pk FROM chats WHERE account_pk = ? AND native_id = ?)`,
              now(),
              accountKey,
              messageId,
              accountKey,
              chatId,
            ).changes
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
          changed += run("UPDATE messages SET deleted_at = ? WHERE pk = ?", now(), candidates[0]?.pk as number).changes
        }
      })
      return changed
    },

    search: async (query, { limit, account }) => find({ text: query, limit, ...(account ? { account } : {}) }),

    find: async (filter) => find(filter),

    savePeople: async (key, people) =>
      inTransaction(() => {
        const accountKey = accountPk(key)
        for (const person of people) identityPk(accountKey, key.provider, person.id, person.name, person)
      }),

    people: async (provider, { account, accounts } = {}) => {
      const within = accounts ?? (account === undefined ? undefined : [account])
      const scope = within
        ? `AND pk IN (SELECT ai.identity_pk FROM account_identities ai JOIN accounts a ON a.pk = ai.account_pk
                      WHERE a.provider = ? AND a.native_id IN (${within.map(() => "?").join(", ") || "NULL"}))`
        : ""
      const rows = all(
        `SELECT native_id, name, username FROM identities WHERE provider = ? ${scope}`,
        provider,
        ...(within ? [provider, ...within] : []),
      )
      const everyone = rows.map(toContact)
      const byId = new Map(everyone.map((person) => [person.id, person]))
      return { get: (id) => byId.get(id), all: () => everyone }
    },

    saveReactions: async (key, chatId, messageId, reactions) => {
      const accountKey = findAccountPk(key)
      const chatKey = accountKey === undefined ? undefined : findChatPk(accountKey, chatId)
      if (chatKey === undefined) return false
      return (
        run(
          "UPDATE messages SET reactions = ? WHERE chat_pk = ? AND native_id = ?",
          JSON.stringify(reactions),
          chatKey,
          messageId,
        ).changes > 0
      )
    },

    markRange: async (key, chatId, from, to) => {
      let merged: Range = { from, to }
      inTransaction(() => {
        const chatKey = chatPkFor(accountPk(key), chatId)
        const touching = all(
          "SELECT from_key, to_key FROM sync_ranges WHERE chat_pk = ? AND from_key <= ? AND to_key >= ?",
          chatKey,
          to + 1,
          from - 1,
        )
        for (const row of touching) {
          merged = {
            from: Math.min(merged.from, Number(row.from_key)),
            to: Math.max(merged.to, Number(row.to_key)),
          }
        }
        run("DELETE FROM sync_ranges WHERE chat_pk = ? AND from_key <= ? AND to_key >= ?", chatKey, to + 1, from - 1)
        run("INSERT INTO sync_ranges (chat_pk, from_key, to_key) VALUES (?, ?, ?)", chatKey, merged.from, merged.to)
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
      if (chatKey === undefined) return []
      return all("SELECT from_key, to_key FROM sync_ranges WHERE chat_pk = ? ORDER BY from_key", chatKey).map(
        (row) => ({ from: Number(row.from_key), to: Number(row.to_key) }),
      )
    },

    close: async () => database.close(),
  }
}

const searchable = (text: string) => ({ normalized_text: normalize(text), normalizer_version: NORMALIZER_VERSION })

const toMs = (iso: string | null | undefined): number | null => {
  if (iso === null || iso === undefined) return null
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : ms
}

const toIso = (ms: unknown): string | null => (typeof ms === "number" ? new Date(ms).toISOString() : null)

const json = (value: unknown): string | null => (value === undefined ? null : JSON.stringify(value))

const parsed = <T>(text: unknown): T | undefined => (typeof text === "string" ? (JSON.parse(text) as T) : undefined)

const present = <T extends Record<string, unknown>>(entries: T) =>
  Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== null && value !== undefined))

const toContact = (row: Record<string, unknown>): Contact => ({
  id: String(row.native_id),
  name: (row.name as string | null) ?? null,
  username: (row.username as string | null) ?? null,
  description: null,
  lastMessagedAt: null,
})

const toChat = (row: Record<string, unknown>): Chat => ({
  id: String(row.native_id),
  title: (row.title as string | null) ?? null,
  kind: row.kind as Chat["kind"],
  unreadCount: (row.unread_count as number | null) ?? null,
  lastMessageAt: toIso(row.last_message_at),
  participantsCount: (row.participants_count as number | null) ?? null,
  ...present({ membershipState: row.membership_state, providerMetadata: parsed(row.provider_metadata) }),
})

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
