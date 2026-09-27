import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { CliError } from "@leemour/cli-core"
import { formatLocator } from "../domain/locator.js"
import type { Attachment, Chat, Id, Message, MessageHit, Page, Provider } from "../domain/models.js"
import type { CacheDatabase, SqlValue } from "./driver.js"
import { migrate } from "./migrations.js"
import { openCache } from "./open.js"
import { storePath } from "./path.js"
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

export interface MessageStore {
  saveAccount(key: AccountKey, account: { name: string | null }): void
  saveChats(key: AccountKey, chats: Chat[]): void
  /** A scheduled message is not kept: it is not history yet. */
  saveMessages(key: AccountKey, chatId: Id, messages: Message[], options: { via: IngestedVia }): void
  chats(key: AccountKey, window: { limit?: number; offset?: number }): Page<Chat>
  /** Oldest to newest, like a provider's history page. */
  messages(key: AccountKey, chatId: Id, window: { limit: number; before?: Id }): Page<Message>
  /** Newest first. At least three characters: a trigram index answers a shorter query with nothing. */
  search(query: string, options: { limit: number; account?: AccountKey }): Page<StoredHit>
  close(): void
}

export interface StoreOptions {
  path?: string
  env?: NodeJS.ProcessEnv
  now?: () => number
}

export const openStore = async ({ path, env, now = Date.now }: StoreOptions = {}): Promise<MessageStore> => {
  const file = path ?? storePath(env)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  // Created before SQLite opens it: SQLite gives -wal and -shm the mode of the database file.
  writeFileSync(file, "", { flag: "a", mode: 0o600 })
  const database = await openCache(file)
  try {
    migrate(database, { now })
  } catch (error) {
    database.close()
    throw error
  }
  return storeOver(database, now)
}

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
                          provider_metadata, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (account_pk, native_id) DO UPDATE SET
         kind = excluded.kind, title = excluded.title, unread_count = excluded.unread_count,
         last_message_at = excluded.last_message_at, participants_count = excluded.participants_count,
         provider_metadata = excluded.provider_metadata, updated_at = excluded.updated_at`,
      accountKey,
      chat.id,
      chat.kind,
      chat.title,
      chat.unreadCount,
      toMs(chat.lastMessageAt),
      chat.participantsCount,
      json(chat.providerMetadata),
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

  /** Every new identity gets its own person; linking two is a later, recorded act. */
  const identityPk = (provider: Provider, nativeId: Id, name: string | null): number => {
    const found = one("SELECT pk, name FROM identities WHERE provider = ? AND native_id = ?", provider, nativeId)
    if (found) {
      // Only on a real change: the search trigger rewrites the index row on every update of `name`.
      if (name !== null && name !== found.name) {
        run("UPDATE identities SET name = ?, updated_at = ? WHERE pk = ?", name, now(), Number(found.pk))
      }
      return Number(found.pk)
    }
    const at = now()
    const identity = Number(
      one(
        `INSERT INTO identities (provider, native_id, name, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?)
         RETURNING pk`,
        provider,
        nativeId,
        name,
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

  const upsertMessage = (key: AccountKey, accountKey: number, chatKey: number, message: Message, via: string) => {
    const sender =
      message.senderId === null || message.senderIsChat
        ? null
        : identityPk(key.provider, message.senderId, message.senderName)
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
      "SELECT pk, text, edited_at FROM messages WHERE chat_pk = ? AND native_id = ?",
      chatKey,
      message.id,
    )
    let pk: number
    if (!found) {
      const columns = Object.keys(fields)
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
        )?.pk,
      )
    } else {
      pk = Number(found.pk)
      // A copy that knows less — no reactions asked for, no quote sent, no sender — never erases what we had.
      const assignments = Object.keys(fields).map((column) => `${column} = coalesce(?, ${column})`)
      run(`UPDATE messages SET ${assignments.join(", ")} WHERE pk = ?`, ...Object.values(fields), pk)
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

  const MESSAGE_COLUMNS = `m.*, c.native_id AS chat_native_id, i.native_id AS sender_native_id`
  const MESSAGE_JOINS = `JOIN chats c ON c.pk = m.chat_pk LEFT JOIN identities i ON i.pk = m.sender_identity_pk`

  return {
    saveAccount: (key, { name }) => {
      accountPk(key, name)
    },

    saveChats: (key, chats) =>
      inTransaction(() => {
        const accountKey = accountPk(key)
        for (const chat of chats) upsertChat(accountKey, chat)
      }),

    saveMessages: (key, chatId, messages, { via }) =>
      inTransaction(() => {
        const accountKey = accountPk(key)
        const chatKey = chatPkFor(accountKey, chatId)
        for (const message of messages) {
          if (message.scheduledFor === undefined) upsertMessage(key, accountKey, chatKey, message, via)
        }
      }),

    chats: (key, { limit, offset = 0 }) => {
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

    messages: (key, chatId, { limit, before }) => {
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

    search: (query, { limit, account }) => {
      const trimmed = query.trim()
      if ([...trimmed].length < 3) {
        throw new CliError("validation_error", "search needs at least three characters")
      }
      const scope = account ? "AND a.provider = ? AND a.native_id = ?" : ""
      const rows = all(
        `SELECT ${MESSAGE_COLUMNS}, c.title AS chat_title, a.provider AS provider, a.native_id AS account_native_id
         FROM messages_fts f JOIN messages m ON m.pk = f.rowid ${MESSAGE_JOINS} JOIN accounts a ON a.pk = m.account_pk
         WHERE messages_fts MATCH ? AND m.deleted_at IS NULL ${scope}
         ORDER BY m.sent_at DESC, m.pk DESC LIMIT ?`,
        `"${trimmed.replaceAll('"', '""')}"`,
        ...(account ? [account.provider, account.account] : []),
        limit + 1,
      )
      const page = rows.slice(0, limit)
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
        hasMore: rows.length > limit,
      }
    },

    close: () => database.close(),
  }
}

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

const toChat = (row: Record<string, unknown>): Chat => ({
  id: String(row.native_id),
  title: (row.title as string | null) ?? null,
  kind: row.kind as Chat["kind"],
  unreadCount: (row.unread_count as number | null) ?? null,
  lastMessageAt: toIso(row.last_message_at),
  participantsCount: (row.participants_count as number | null) ?? null,
  ...present({ providerMetadata: parsed(row.provider_metadata) }),
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
