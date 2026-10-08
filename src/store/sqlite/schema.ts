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
    /** When the owner asked `serve` to fetch its member list daily; `NULL` when not tracked. */
    membersTrackedAt: integer("members_tracked_at"),
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
    /**
     * Set on a piece of one message longer than a chunk (`first_message_pk` = `last_message_pk`): the
     * stretch of its text the piece holds, as offsets. `NULL` is the whole of every message in range.
     */
    textStart: integer("text_start"),
    textEnd: integer("text_end"),
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
    /** `chat`, `contact`, `message`, `knowledge` (before version 27), `note` or `owner`. */
    taggableType: text("taggable_type").notNull(),
    taggablePk: integer("taggable_pk").notNull(),
    tag: text("tag").notNull(),
    createdAt: integer("created_at").notNull(),
    manual: integer("manual").notNull().default(1),
  },
  (table) => [
    unique().on(table.taggableType, table.taggablePk, table.tag),
    index("tags_by_tag").on(table.tag, table.taggableType, table.taggablePk),
  ],
)

/**
 * Every run of `search messages` and `stats messages show`, with the parameters as the caller gave them — never
 * a message or a result. A row with a name is a saved search; an identical unnamed run counts on its row.
 */
export const searches = sqliteTable(
  "searches",
  {
    pk: integer("pk").primaryKey(),
    name: text("name").unique(),
    /** `search` or `stats`. */
    command: text("command").notNull(),
    /** JSON, keys sorted, so the same run is the same text. */
    params: text("params").notNull(),
    /** `lucene-v1` or `legacy`. */
    language: text("language").notNull(),
    version: integer("version").notNull(),
    fieldsVersion: integer("fields_version").notNull(),
    createdAt: integer("created_at").notNull(),
    lastRunAt: integer("last_run_at"),
    runs: integer("runs").notNull().default(0),
  },
  (table) => [
    uniqueIndex("searches_history").on(table.command, table.params).where(sql`name IS NULL`),
    index("searches_by_last_run").on(desc(table.lastRunAt)),
  ],
)

/**
 * One stay of a person in a group, from member lists read whole or in part. A return after leaving is a new
 * row. `gone_at` is set only from a list read whole: a cut list says nothing about who is missing.
 */
export const memberStays = sqliteTable(
  "member_stays",
  {
    pk: integer("pk").primaryKey(),
    chatPk: integer("chat_pk")
      .notNull()
      .references(() => chats.pk),
    identityPk: integer("identity_pk")
      .notNull()
      .references(() => identities.pk),
    firstSeenAt: integer("first_seen_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    /** When the messenger says they joined; `NULL` where it does not. */
    joinedAt: integer("joined_at"),
    invitedByPk: integer("invited_by_pk").references(() => identities.pk),
    role: text("role"),
    goneAt: integer("gone_at"),
  },
  (table) => [
    uniqueIndex("member_stays_open").on(table.chatPk, table.identityPk).where(sql`gone_at IS NULL`),
    index("member_stays_by_identity").on(table.identityPk),
  ],
)

/** A group's size once a day: the messenger's own count and how many members one read listed. */
export const memberCounts = sqliteTable(
  "member_counts",
  {
    chatPk: integer("chat_pk")
      .notNull()
      .references(() => chats.pk),
    /** `YYYY-MM-DD`, UTC; a later read the same day replaces the row. */
    day: text("day").notNull(),
    participants: integer("participants"),
    listed: integer("listed").notNull(),
    complete: integer("complete").notNull(),
    at: integer("at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.chatPk, table.day] })],
)

export const membershipBatches = sqliteTable(
  "membership_batches",
  {
    pk: integer("pk").primaryKey(),
    chatPk: integer("chat_pk")
      .notNull()
      .references(() => chats.pk, { onDelete: "cascade" }),
    observedAt: integer("observed_at").notNull(),
    startedAt: integer("started_at"),
    complete: integer("complete").notNull(),
    participants: integer("participants"),
    listed: integer("listed").notNull(),
    source: text("source").notNull(),
  },
  (table) => [index("membership_batches_by_chat_time").on(table.chatPk, table.observedAt)],
)

export const membershipBatchMembers = sqliteTable(
  "membership_batch_members",
  {
    batchPk: integer("batch_pk")
      .notNull()
      .references(() => membershipBatches.pk, { onDelete: "cascade" }),
    identityPk: integer("identity_pk")
      .notNull()
      .references(() => identities.pk, { onDelete: "cascade" }),
    stayPk: integer("stay_pk")
      .notNull()
      .references(() => memberStays.pk, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.batchPk, table.identityPk] }),
    index("membership_members_by_stay").on(table.stayPk, table.batchPk),
  ],
)

export const messageCounterObservations = sqliteTable(
  "message_counter_observations",
  {
    messagePk: integer("message_pk")
      .notNull()
      .references(() => messages.pk, { onDelete: "cascade" }),
    counter: text("counter").notNull(),
    value: real("value").notNull(),
    observedAt: integer("observed_at").notNull(),
    source: text("source").notNull(),
  },
  (table) => [primaryKey({ columns: [table.messagePk, table.counter] })],
)

/** Each profile a person was seen with, a row when it differs from the one before; `identities` holds the latest. */
export const identityRevisions = sqliteTable(
  "identity_revisions",
  {
    pk: integer("pk").primaryKey(),
    identityPk: integer("identity_pk")
      .notNull()
      .references(() => identities.pk),
    name: text("name"),
    username: text("username"),
    description: text("description"),
    /** JSON: the messenger's marks — bot, scam, fake, deleted, has a photo — where it gave them. */
    marks: text("marks"),
    capturedAt: integer("captured_at").notNull(),
  },
  (table) => [index("identity_revisions_by_identity").on(table.identityPk, table.capturedAt)],
)

/**
 * The text of one attachment: read from the saved file (`origin` `extracted`) or written back by an
 * agent that read a scan or a photo (`agent`). No foreign key: a build that predates this table deletes
 * attachments in its purges, and a key would refuse that; triggers erase the text instead (NEED-393 A).
 */
export const attachmentTexts = sqliteTable("attachment_texts", {
  attachmentPk: integer("attachment_pk").primaryKey(),
  text: text("text").notNull(),
  normalizedText: text("normalized_text").notNull(),
  /** `extracted` or `agent`. */
  origin: text("origin").notNull(),
  /** `plain`, `docx:mammoth@1.13.0`, `pdf:unpdf@1.8.1`, or the agent's own label. */
  extractor: text("extractor").notNull(),
  contentSha256: text("content_sha256"),
  /** The file's size when it was read; a file of another size is read again. */
  bytes: integer("bytes"),
  /** Why no text came out — a reason code, never a line of the file. */
  error: text("error"),
  writtenAt: integer("written_at").notNull(),
})

/**
 * What `@leemour/cli-tasks` keeps: a question, request, mention or promise waiting on the owner. `source`
 * is a locator (`msg:…`), never the message text. Times are milliseconds.
 */
export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    sourceKind: text("source_kind").notNull(),
    account: text("account").notNull(),
    groupKey: text("group_key").notNull(),
    kind: text("kind").notNull(),
    state: text("state").notNull(),
    reason: text("reason"),
    origin: text("origin").notNull(),
    createdAt: integer("created_at").notNull(),
    dueAt: integer("due_at"),
    closedAt: integer("closed_at"),
    closedBy: text("closed_by"),
  },
  (table) => [
    index("tasks_by_source").on(table.account, table.source),
    index("tasks_by_state").on(table.account, table.state, table.groupKey),
  ],
)

export const contactAliases = sqliteTable(
  "contact_aliases",
  {
    accountPk: integer("account_pk")
      .notNull()
      .references(() => accounts.pk),
    identityPk: integer("identity_pk")
      .notNull()
      .references(() => identities.pk),
    alias: text("alias"),
    aliasFolded: text("alias_folded"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.accountPk, table.identityPk] })],
)

export const annotations = sqliteTable(
  "annotations",
  {
    uid: text("uid").primaryKey(),
    accountPk: integer("account_pk")
      .notNull()
      .references(() => accounts.pk),
    targetType: text("target_type").notNull(),
    targetPk: integer("target_pk").notNull(),
    text: text("text").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    authoredBy: text("authored_by").notNull(),
  },
  (table) => [index("annotations_by_target").on(table.accountPk, table.targetType, table.targetPk)],
)

export const knowledgeTargets = sqliteTable(
  "knowledge_targets",
  {
    pk: integer("pk").primaryKey({ autoIncrement: true }),
    accountPk: integer("account_pk")
      .notNull()
      .references(() => accounts.pk),
    type: text("type").notNull(),
    reference: text("reference").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [uniqueIndex("knowledge_target_identity").on(table.accountPk, table.type, table.reference)],
)

export const knowledgeEntities = sqliteTable("knowledge_entities", {
  uid: text("uid").primaryKey(),
  accountPk: integer("account_pk")
    .notNull()
    .references(() => accounts.pk),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  createdAt: integer("created_at").notNull(),
})

export const knowledgeRelations = sqliteTable(
  "knowledge_relations",
  {
    uid: text("uid").primaryKey(),
    accountPk: integer("account_pk")
      .notNull()
      .references(() => accounts.pk),
    fromRef: text("from_ref").notNull(),
    toRef: text("to_ref").notNull(),
    kind: text("kind").notNull(),
    role: text("role"),
    evidence: text("evidence"),
    confirmed: integer("confirmed").notNull().default(1),
    provenance: text("provenance"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [uniqueIndex("knowledge_relation_identity").on(table.accountPk, table.fromRef, table.toRef, table.kind)],
)

export const knowledgeReminders = sqliteTable(
  "knowledge_reminders",
  {
    uid: text("uid").primaryKey(),
    accountPk: integer("account_pk")
      .notNull()
      .references(() => accounts.pk),
    taskId: text("task_id").notNull(),
    dueAt: integer("due_at").notNull(),
    timezone: text("timezone").notNull(),
    state: text("state").notNull(),
    revision: integer("revision").notNull().default(1),
    leaseUntil: integer("lease_until"),
    receipt: text("receipt"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("knowledge_reminders_due").on(table.accountPk, table.state, table.dueAt)],
)

export const chatMetadata = sqliteTable("chat_metadata", {
  chatPk: integer("chat_pk")
    .primaryKey()
    .references(() => chats.pk),
  title: text("title"),
  username: text("username"),
  description: text("description"),
  fetchedAt: integer("fetched_at").notNull(),
})

export const autoTagClaims = sqliteTable(
  "auto_tag_claims",
  {
    chatPk: integer("chat_pk")
      .notNull()
      .references(() => chats.pk),
    tag: text("tag").notNull(),
    algorithm: text("algorithm").notNull(),
    score: real("score").notNull(),
    fields: text("fields").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.chatPk, table.tag] })],
)

/**
 * The path lives in each computer's config, never here. A folder copied from a pre-25 `notes` account
 * keeps that account in `account_pk` and its path in `pending_path` until the notes tool claims it.
 */
export const noteFolders = sqliteTable("note_folders", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  format: text("format").notNull(),
  pendingPath: text("pending_path"),
  accountPk: integer("account_pk")
    .unique()
    .references(() => accounts.pk),
  createdAt: integer("created_at").notNull(),
})

export const notes = sqliteTable(
  "notes",
  {
    pk: integer("pk").primaryKey(),
    id: text("id").notNull().unique(),
    source: text("source").notNull(),
    folderId: text("folder_id").references(() => noteFolders.id),
    path: text("path"),
    title: text("title"),
    text: text("text").notNull(),
    frontMatter: text("front_matter"),
    contentHash: text("content_hash"),
    revision: integer("revision").notNull().default(1),
    exportPath: text("export_path"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (table) => [uniqueIndex("notes_by_path").on(table.folderId, table.path)],
)

export const noteRevisions = sqliteTable(
  "note_revisions",
  {
    notePk: integer("note_pk")
      .notNull()
      .references(() => notes.pk),
    text: text("text").notNull(),
    capturedAt: integer("captured_at").notNull(),
  },
  (table) => [index("note_revisions_by_note").on(table.notePk)],
)

/**
 * A note cut into pieces for embedding, each by the stretch of its indexed text it holds. The text is
 * never stored twice; `content_hash` finds the piece's vector in `chunk_vectors`, shared with conversations.
 */
export const noteChunks = sqliteTable(
  "note_chunks",
  {
    notePk: integer("note_pk")
      .notNull()
      .references(() => notes.pk, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    textStart: integer("text_start").notNull(),
    textEnd: integer("text_end").notNull(),
    contentHash: text("content_hash").notNull(),
  },
  (table) => [primaryKey({ columns: [table.notePk, table.seq] }), index("note_chunks_by_hash").on(table.contentHash)],
)

/**
 * Every connection between two things, by typed reference. `to_ref` is null while a link names nobody
 * yet; `target_folded` is what a new person or alias is matched against to resolve it.
 */
export const links = sqliteTable(
  "links",
  {
    id: text("id").primaryKey(),
    fromRef: text("from_ref").notNull(),
    toRef: text("to_ref"),
    kind: text("kind").notNull(),
    anchor: text("anchor"),
    origin: text("origin").notNull(),
    targetText: text("target_text"),
    targetFolded: text("target_folded"),
    role: text("role"),
    evidence: text("evidence"),
    provenance: text("provenance"),
    confirmed: integer("confirmed").notNull().default(1),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("links_from").on(table.fromRef),
    index("links_to").on(table.toRef),
    index("links_unresolved").on(table.targetFolded).where(sql`to_ref IS NULL`),
  ],
)

/**
 * What the owner labels that belongs to no account: a person, an entity, a task, a notes folder or one
 * of its subfolders. Tags of type `owner` point here. A folder keeps its id and path apart as well, so a
 * search can find every note under a labelled subfolder without decoding the reference.
 */
export const ownerTargets = sqliteTable(
  "owner_targets",
  {
    pk: integer("pk").primaryKey(),
    reference: text("reference").notNull().unique(),
    folderId: text("folder_id"),
    folderPath: text("folder_path"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("owner_targets_by_folder").on(table.folderId, table.folderPath)],
)

export const entities = sqliteTable("entities", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  createdAt: integer("created_at").notNull(),
})
