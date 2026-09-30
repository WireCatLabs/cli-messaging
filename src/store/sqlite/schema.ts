import { desc, sql } from "drizzle-orm"
import { index, integer, primaryKey, real, sqliteTable, text, unique } from "drizzle-orm/sqlite-core"

/**
 * The store's base tables — what `drizzle-kit generate` diffs against.
 * A change here becomes a migration, so it follows the rules at the top of `../migrations.ts`. The
 * FTS5 tables and their triggers are not modelled by Drizzle and live in hand-written SQL.
 */

export const accounts = sqliteTable(
  "accounts",
  {
    pk: integer("pk").primaryKey(),
    provider: text("provider").notNull(),
    nativeId: text("native_id").notNull(),
    name: text("name"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [unique().on(table.provider, table.nativeId)],
)

export const persons = sqliteTable("persons", {
  pk: integer("pk").primaryKey(),
  uid: text("uid").notNull().unique(),
  name: text("name"),
  isSelf: integer("is_self").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
})

export const identities = sqliteTable(
  "identities",
  {
    pk: integer("pk").primaryKey(),
    provider: text("provider").notNull(),
    nativeId: text("native_id").notNull(),
    username: text("username"),
    name: text("name"),
    isBot: integer("is_bot"),
    phoneHmac: text("phone_hmac"),
    providerMetadata: text("provider_metadata"),
    firstSeenAt: integer("first_seen_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [unique().on(table.provider, table.nativeId)],
)

export const identityLinks = sqliteTable(
  "identity_links",
  {
    identityPk: integer("identity_pk")
      .primaryKey()
      .references(() => identities.pk),
    personPk: integer("person_pk")
      .notNull()
      .references(() => persons.pk),
    method: text("method").notNull(),
    confidence: real("confidence").notNull(),
    linkedAt: integer("linked_at").notNull(),
    linkedBy: text("linked_by").notNull(),
  },
  (table) => [index("identity_links_by_person").on(table.personPk)],
)

export const identityLinkEvents = sqliteTable("identity_link_events", {
  pk: integer("pk").primaryKey(),
  identityPk: integer("identity_pk")
    .notNull()
    .references(() => identities.pk),
  fromPersonPk: integer("from_person_pk").references(() => persons.pk),
  toPersonPk: integer("to_person_pk")
    .notNull()
    .references(() => persons.pk),
  method: text("method").notNull(),
  at: integer("at").notNull(),
  by: text("by").notNull(),
})

export const chats = sqliteTable(
  "chats",
  {
    pk: integer("pk").primaryKey(),
    accountPk: integer("account_pk")
      .notNull()
      .references(() => accounts.pk),
    nativeId: text("native_id").notNull(),
    kind: text("kind").notNull(),
    title: text("title"),
    unreadCount: integer("unread_count"),
    lastMessageAt: integer("last_message_at"),
    participantsCount: integer("participants_count"),
    providerMetadata: text("provider_metadata"),
    updatedAt: integer("updated_at").notNull(),
    username: text("username"),
    /** `NULL` is unknown. Searchable does not follow from it: a chat left keeps its messages. */
    membershipState: text("membership_state"),
    isSearchable: integer("is_searchable").notNull().default(1),
    /** Kept by triggers, so phase 2 can choose per query how a filter reaches the index. */
    messageCount: integer("message_count").notNull().default(0),
  },
  (table) => [
    unique().on(table.accountPk, table.nativeId),
    index("chats_by_recency").on(table.accountPk, desc(table.lastMessageAt)),
  ],
)

export const messages = sqliteTable(
  "messages",
  {
    pk: integer("pk").primaryKey(),
    chatPk: integer("chat_pk")
      .notNull()
      .references(() => chats.pk),
    accountPk: integer("account_pk")
      .notNull()
      .references(() => accounts.pk),
    nativeId: text("native_id").notNull(),
    threadNativeId: text("thread_native_id"),
    senderIdentityPk: integer("sender_identity_pk").references(() => identities.pk),
    senderChatNativeId: text("sender_chat_native_id"),
    senderName: text("sender_name"),
    sentAt: integer("sent_at").notNull(),
    editedAt: integer("edited_at"),
    deletedAt: integer("deleted_at"),
    text: text("text").notNull(),
    replyToNativeId: text("reply_to_native_id"),
    replyTo: text("reply_to"),
    forward: text("forward"),
    outgoing: integer("outgoing"),
    reactions: text("reactions"),
    providerMetadata: text("provider_metadata"),
    ingestedAt: integer("ingested_at").notNull(),
    ingestedVia: text("ingested_via").notNull(),
    normalizedText: text("normalized_text"),
    normalizerVersion: integer("normalizer_version"),
  },
  (table) => [
    unique().on(table.chatPk, table.nativeId),
    index("messages_by_time").on(table.chatPk, desc(table.sentAt)),
    index("messages_by_account").on(table.accountPk, table.nativeId),
    index("messages_by_sender").on(table.senderIdentityPk),
    // Empty once the backfill is done, so every open can ask "anything left?" without reading the table.
    index("messages_to_normalize").on(table.pk).where(sql`normalized_text IS NULL AND deleted_at IS NULL`),
  ],
)

export const messageRevisions = sqliteTable(
  "message_revisions",
  {
    messagePk: integer("message_pk")
      .notNull()
      .references(() => messages.pk),
    text: text("text").notNull(),
    editedAt: integer("edited_at"),
    capturedAt: integer("captured_at").notNull(),
  },
  (table) => [index("revisions_by_message").on(table.messagePk)],
)

export const attachments = sqliteTable(
  "attachments",
  {
    pk: integer("pk").primaryKey(),
    messagePk: integer("message_pk")
      .notNull()
      .references(() => messages.pk),
    position: integer("position").notNull(),
    kind: text("kind").notNull(),
    mime: text("mime"),
    name: text("name"),
    title: text("title"),
    url: text("url"),
    size: integer("size"),
    width: integer("width"),
    height: integer("height"),
    duration: real("duration"),
    providerRef: text("provider_ref"),
    localPath: text("local_path"),
  },
  (table) => [unique().on(table.messagePk, table.position)],
)

export const syncRanges = sqliteTable(
  "sync_ranges",
  {
    chatPk: integer("chat_pk")
      .notNull()
      .references(() => chats.pk),
    fromKey: integer("from_key").notNull(),
    toKey: integer("to_key").notNull(),
  },
  (table) => [primaryKey({ columns: [table.chatPk, table.fromKey] })],
)

export const accountIdentities = sqliteTable(
  "account_identities",
  {
    accountPk: integer("account_pk")
      .notNull()
      .references(() => accounts.pk),
    identityPk: integer("identity_pk")
      .notNull()
      .references(() => identities.pk),
    firstSeenAt: integer("first_seen_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.accountPk, table.identityPk] })],
)

/** Who is in a chat, as the account last saw it: a list replaces the chat's membership whole. */
export const chatMembers = sqliteTable(
  "chat_members",
  {
    chatPk: integer("chat_pk")
      .notNull()
      .references(() => chats.pk),
    identityPk: integer("identity_pk")
      .notNull()
      .references(() => identities.pk),
  },
  (table) => [
    primaryKey({ columns: [table.chatPk, table.identityPk] }),
    index("chat_members_by_identity").on(table.identityPk),
  ],
)
