import {
  blob,
  desc,
  index,
  integer,
  primaryKey,
  real,
  sql,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "./drizzle/core.js"

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
    /** What they wrote about themselves. */
    description: text("description"),
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
    /** JSON: the people the text mentions by id, where the messenger says so; `@handle`s are read from the text. */
    mentions: text("mentions"),
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
    /** Their one-to-one chat's newest message, as `refreshRecency` last worked it out: the contact order. */
    lastMessagedAt: integer("last_messaged_at"),
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

/** Per account, what a sync remembers between runs: a delta marker, when a list was last complete. */
export const syncState = sqliteTable(
  "sync_state",
  {
    accountPk: integer("account_pk")
      .notNull()
      .references(() => accounts.pk),
    key: text("key").notNull(),
    value: text("value").notNull(),
    at: integer("at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.accountPk, table.key] })],
)

/** Who is fetching a stretch of a chat right now, so two processes do not fetch the same pages. */
export const fetchLeases = sqliteTable(
  "fetch_leases",
  {
    chatPk: integer("chat_pk")
      .notNull()
      .references(() => chats.pk),
    anchor: text("anchor").notNull(),
    holder: text("holder").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.chatPk, table.anchor] })],
)

/**
 * What a voice message said, keyed by chat and message id rather than a message row: a message can
 * be heard before the store holds it. Derived — it can be heard again.
 */
export const transcripts = sqliteTable(
  "transcripts",
  {
    chatPk: integer("chat_pk")
      .notNull()
      .references(() => chats.pk),
    messageNativeId: text("message_native_id").notNull(),
    text: text("text").notNull(),
    /** The model or the messenger that heard it. */
    source: text("source").notNull(),
    heardAt: integer("heard_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.chatPk, table.messageNativeId] })],
)

/**
 * How far a derived search index is built, one row per index. `watermark` is the highest message
 * `pk` when the index was created: rows above it are indexed by triggers, rows up to it by batches
 * that have reached `filled_through`.
 */
export const searchIndexState = sqliteTable("search_index_state", {
  name: text("name").primaryKey(),
  watermark: integer("watermark").notNull(),
  filledThrough: integer("filled_through").notNull(),
  termsThrough: integer("terms_through").notNull(),
  normalizerVersion: integer("normalizer_version").notNull(),
  builtAt: integer("built_at"),
  /** The stemmer choices and Snowball version that built the stems row (`analyzerIdentity`); NULL until a fill claims it. */
  analyzer: text("analyzer"),
})

/** Messages whose stems are stale. Triggers fill it, because SQL cannot stem; JS empties it. */
export const messageStemsPending = sqliteTable("message_stems_pending", {
  pk: integer("pk").primaryKey(),
})

/** Settings of the store file itself, shared by every profile, tg and MAX — unlike a profile's config file. */
export const storeSettings = sqliteTable("store_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  at: integer("at").notNull(),
})

/*
 * Phase 3's conversations. All four are derived — rebuilt from `messages`, never the only copy of
 * anything — so every foreign key cascades: a build that knows nothing of them can still delete the
 * messages and chats they point at.
 */

/** Each candidate for "the earlier message this one answers", and where it came from. */
export const messageLinks = sqliteTable(
  "message_links",
  {
    /** The message's chat, kept here so a rebuild finds and drops an old build without reading `messages`. */
    chatPk: integer("chat_pk")
      .notNull()
      .references(() => chats.pk, { onDelete: "cascade" }),
    messagePk: integer("message_pk")
      .notNull()
      .references(() => messages.pk, { onDelete: "cascade" }),
    /** `NULL`: the source says this message starts a conversation. */
    parentPk: integer("parent_pk").references(() => messages.pk, { onDelete: "cascade" }),
    source: text("source").notNull(),
    kind: text("kind").notNull(),
    confidence: real("confidence").notNull(),
    /** The rule's name, or the agent's model. */
    method: text("method").notNull(),
    version: text("version"),
    /** Which agent batch wrote it (phase 4). */
    batch: text("batch"),
    /** The rebuild that wrote a provider or rule link; `NULL` for an agent's, which outlive rebuilds. */
    build: integer("build"),
    createdAt: integer("created_at").notNull(),
    /** An end of the link changed after it was written; never chosen until asked again. */
    staleAt: integer("stale_at"),
  },
  (table) => [
    // NULLs are distinct to a UNIQUE constraint: "starts a conversation" and agent links would repeat.
    uniqueIndex("message_links_unique").on(
      table.messagePk,
      sql`ifnull(${table.parentPk}, 0)`,
      table.source,
      table.kind,
      sql`ifnull(${table.build}, 0)`,
    ),
    index("message_links_by_parent").on(table.parentPk),
    index("message_links_by_build").on(table.chatPk, table.build),
  ],
)

export const conversations = sqliteTable(
  "conversations",
  {
    pk: integer("pk").primaryKey(),
    chatPk: integer("chat_pk")
      .notNull()
      .references(() => chats.pk, { onDelete: "cascade" }),
    firstMessagePk: integer("first_message_pk")
      .notNull()
      .references(() => messages.pk, { onDelete: "cascade" }),
    /** Written in batches under a new number, then made current at once: readers never see half a build. */
    build: integer("build").notNull(),
    firstAt: integer("first_at").notNull(),
    lastAt: integer("last_at").notNull(),
    messageCount: integer("message_count").notNull(),
    builtAt: integer("built_at").notNull(),
    algorithmVersion: integer("algorithm_version").notNull(),
  },
  (table) => [index("conversations_by_chat").on(table.chatPk, table.build, table.firstAt)],
)

export const conversationMessages = sqliteTable(
  "conversation_messages",
  {
    conversationPk: integer("conversation_pk")
      .notNull()
      .references(() => conversations.pk, { onDelete: "cascade" }),
    messagePk: integer("message_pk")
      .notNull()
      .references(() => messages.pk, { onDelete: "cascade" }),
  },
  // A message is in one conversation of each build; the current build and the one being written overlap.
  (table) => [
    primaryKey({ columns: [table.conversationPk, table.messagePk] }),
    index("conversation_messages_by_message").on(table.messagePk),
  ],
)

/** Which chats the user enabled, and how fresh their conversations are. */
export const conversationState = sqliteTable("conversation_state", {
  chatPk: integer("chat_pk")
    .primaryKey()
    .references(() => chats.pk, { onDelete: "cascade" }),
  enabledAt: integer("enabled_at").notNull(),
  builtAt: integer("built_at"),
  algorithmVersion: integer("algorithm_version"),
  /** The build readers see; a higher one is being written, or failed. */
  currentBuild: integer("current_build"),
})

/*
 * Phase 5's search by meaning. Chunks are derived per build, as conversations are; a vector is keyed by
 * the text it encodes, so a rebuild that leaves a conversation's text alone reuses it.
 */

/** A conversation, or a run of its messages when it is longer than one chunk. */
export const conversationChunks = sqliteTable(
  "conversation_chunks",
  {
    conversationPk: integer("conversation_pk")
      .notNull()
      .references(() => conversations.pk, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    firstMessagePk: integer("first_message_pk")
      .notNull()
      .references(() => messages.pk, { onDelete: "cascade" }),
    lastMessagePk: integer("last_message_pk")
      .notNull()
      .references(() => messages.pk, { onDelete: "cascade" }),
    /** sha256 of the text the model is given, hex. The chunk's text itself is never stored. */
    contentHash: text("content_hash").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationPk, table.ordinal] }),
    index("conversation_chunks_by_hash").on(table.contentHash),
  ],
)

/** One model's vector for one chunk text; no chat, so vectors outlive the builds that point at them. */
export const chunkVectors = sqliteTable(
  "chunk_vectors",
  {
    /** `<provider>:<model>:<dims>` — vectors of different models never mix. */
    model: text("model").notNull(),
    contentHash: text("content_hash").notNull(),
    dims: integer("dims").notNull(),
    /** Float32, little-endian, length one. */
    vector: blob("vector", { mode: "buffer" }).notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.model, table.contentHash] })],
)

/**
 * The owner's own labels on a chat, a contact (an `identities` row) or one message. Polymorphic, so no
 * foreign key: triggers drop a tag when its chat or message goes, whichever build deletes it.
 */
export const tags = sqliteTable(
  "tags",
  {
    pk: integer("pk").primaryKey(),
    /** `chat`, `contact` or `message`. */
    taggableType: text("taggable_type").notNull(),
    taggablePk: integer("taggable_pk").notNull(),
    tag: text("tag").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    unique().on(table.taggableType, table.taggablePk, table.tag),
    index("tags_by_tag").on(table.tag, table.taggableType, table.taggablePk),
  ],
)
