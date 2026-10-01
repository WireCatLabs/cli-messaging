import { setTimeout } from "node:timers/promises"
import type { Link, LinkInput } from "../../conversations/link.js"
import type { Id, Message } from "../../domain/models.js"
import type { ConversationBuild, ConversationSummary, StoredLink } from "../store.js"
import { and, asc, desc, eq, isNull, type SQL, sql } from "./drizzle/core.js"
import type { StoreContext } from "./open.js"
import { selectMessages, toMessages } from "./reads.js"
import {
  chats,
  conversationMessages,
  conversationState,
  conversations,
  identities,
  messageLinks,
  messages,
} from "./schema.js"
import { toIso } from "./values.js"

const position = (sentAt: number, pk: number) => `${sentAt}:${pk}`

/** A chat's live messages for the rules, oldest first, a page at a time; `next` continues it. */
export const linkInputs = (
  { orm }: StoreContext,
  chatKey: number,
  { after, limit }: { after?: string; limit: number },
): { items: LinkInput[]; next: string | null } => {
  const [sentAt, pk] = (after ?? "").split(":").map(Number)
  const rows = orm
    .select({
      pk: messages.pk,
      id: messages.nativeId,
      senderId: sql<string | null>`coalesce(${messages.senderChatNativeId}, ${identities.nativeId})`,
      text: messages.text,
      sentAt: messages.sentAt,
      replyToId: messages.replyToNativeId,
      threadId: messages.threadNativeId,
    })
    .from(messages)
    .leftJoin(identities, eq(identities.pk, messages.senderIdentityPk))
    .where(
      and(
        eq(messages.chatPk, chatKey),
        isNull(messages.deletedAt),
        after === undefined ? undefined : sql`(${messages.sentAt}, ${messages.pk}) > (${sentAt}, ${pk})`,
      ),
    )
    .orderBy(asc(messages.sentAt), asc(messages.pk))
    .limit(limit)
    .all()
  const last = rows.at(-1)
  return {
    items: rows.map((row) => ({
      id: row.id,
      senderId: row.senderId,
      text: row.text,
      timestamp: toIso(row.sentAt) as string,
      ...(row.replyToId === null ? {} : { replyToId: row.replyToId }),
      ...(row.threadId === null ? {} : { threadId: row.threadId }),
    })),
    next: rows.length === limit && last ? position(last.sentAt, last.pk) : null,
  }
}

/** The usernames of everyone who wrote in the chat, lowercased, to their id: what a mention names. */
export const senderHandles = ({ orm }: StoreContext, chatKey: number): Map<string, Id> =>
  new Map(
    orm
      .selectDistinct({ username: identities.username, id: identities.nativeId })
      .from(messages)
      .innerJoin(identities, eq(identities.pk, messages.senderIdentityPk))
      .where(and(eq(messages.chatPk, chatKey), sql`${identities.username} IS NOT NULL`))
      .all()
      .map(({ username, id }) => [String(username).toLowerCase(), id]),
  )

const inChat = (chatKey: number) => eq(messageLinks.chatPk, chatKey)

/**
 * A long write cut into short transactions with a pause between them. Without the pause the next
 * `BEGIN IMMEDIATE` wins the lock again at once: a process waiting for it sleeps up to 100 ms at a time
 * and, measured, waited out the whole build (1.8 s of 1.9 s at 100k messages). It gives up at 5 s.
 * `work` writes one row per step, synchronously: nothing awaits while a transaction is open (D3).
 */
const inTurns = async ({ database }: StoreContext, work: Iterator<unknown>, { holdMs = 250, pauseMs = 120 } = {}) => {
  for (let done = false; !done; ) {
    database.exec("BEGIN IMMEDIATE")
    try {
      const since = performance.now()
      do done = work.next().done === true
      while (!done && performance.now() - since < holdMs)
      database.exec("COMMIT")
    } catch (error) {
      database.exec("ROLLBACK")
      throw error
    }
    if (!done) await setTimeout(pauseMs)
  }
}

const once = (body: () => void): Iterator<unknown> => ({
  next: () => {
    body()
    return { done: true, value: undefined }
  },
})

const highestBuild = ({ orm }: StoreContext, chatKey: number): number =>
  Number(
    orm
      .select({
        n: sql<number>`max(
          coalesce((SELECT max(${conversations.build}) FROM ${conversations} WHERE ${conversations.chatPk} = ${chatKey}), 0),
          coalesce((SELECT max(${messageLinks.build}) FROM ${messageLinks} WHERE ${inChat(chatKey)}), 0),
          coalesce((SELECT ${conversationState.currentBuild} FROM ${conversationState}
            WHERE ${conversationState.chatPk} = ${chatKey}), 0))`,
      })
      .from(sql`(SELECT 1)`)
      .get()?.n,
  )

/**
 * Plan C3–C4, corrected by NEED-475 A. The chat's provider and rule links and its conversations are
 * written under a new build number in short transactions; one more makes that build the one readers
 * see; older builds are then deleted, a batch at a time. Until the switch readers see the previous
 * build, so a failed build leaves it in place. Agent links have no build and stay; one whose message
 * or parent was edited or deleted after it was written is marked stale.
 */
export const replaceConversations = async (
  context: StoreContext,
  chatKey: number,
  { startedAt, algorithmVersion, links, conversations: groups }: ConversationBuild,
  batch = 5_000,
): Promise<void> => {
  const { orm, now } = context
  const held = new Map(
    orm
      .select({ id: messages.nativeId, pk: messages.pk, sentAt: messages.sentAt })
      .from(messages)
      .where(eq(messages.chatPk, chatKey))
      .all()
      .map((row) => [row.id, row]),
  )
  let build = 0
  await inTurns(
    context,
    once(() => {
      // By start time, so a build that started later is the newer one; never one already used.
      build = Math.max(startedAt, highestBuild(context, chatKey) + 1)
      orm.insert(conversationState).values({ chatPk: chatKey, enabledAt: startedAt }).onConflictDoNothing().run()
    }),
  )

  const insertLink = orm
    .insert(messageLinks)
    .values({
      chatPk: chatKey,
      messagePk: sql.placeholder("messagePk"),
      parentPk: sql.placeholder("parentPk"),
      source: sql.placeholder("source"),
      kind: sql.placeholder("kind"),
      confidence: sql.placeholder("confidence"),
      method: sql.placeholder("method"),
      version: String(algorithmVersion),
      createdAt: startedAt,
      build,
    })
    .onConflictDoNothing()
    .prepare()
  const insertMember = orm
    .insert(conversationMessages)
    .values({ conversationPk: sql.placeholder("conversationPk"), messagePk: sql.placeholder("messagePk") })
    .prepare()
  await inTurns(
    context,
    (function* () {
      for (const link of links) {
        const message = held.get(link.messageId)
        const parent = held.get(link.parentId)
        if (!message || !parent) continue
        insertLink.run(row(link, message.pk, parent.pk))
        yield
      }
      for (const ids of groups) {
        const members = ids.flatMap((id) => held.get(id) ?? [])
        const first = members[0]
        if (!first) continue
        const created = orm
          .insert(conversations)
          .values({
            chatPk: chatKey,
            build,
            firstMessagePk: first.pk,
            firstAt: first.sentAt,
            lastAt: members.reduce((last, member) => Math.max(last, member.sentAt), first.sentAt),
            messageCount: members.length,
            builtAt: startedAt,
            algorithmVersion,
          })
          .returning({ pk: conversations.pk })
          .get()
        for (const member of members) {
          insertMember.run({ conversationPk: created.pk, messagePk: member.pk })
          yield
        }
      }
    })(),
  )

  const changedSince = (end: SQL) => sql`(
    EXISTS (SELECT 1 FROM message_revisions r WHERE r.message_pk = ${end} AND r.captured_at > ${messageLinks.createdAt})
    OR EXISTS (SELECT 1 FROM messages d WHERE d.pk = ${end} AND d.deleted_at > ${messageLinks.createdAt}))`
  await inTurns(
    context,
    once(() => {
      orm
        .update(messageLinks)
        .set({ staleAt: now() })
        .where(
          and(
            eq(messageLinks.source, "agent"),
            isNull(messageLinks.staleAt),
            inChat(chatKey),
            sql`(${changedSince(sql`${messageLinks.messagePk}`)} OR ${changedSince(sql`${messageLinks.parentPk}`)})`,
          ),
        )
        .run()
      // A slower build that started earlier and finishes later must not replace a newer one.
      orm
        .update(conversationState)
        .set({ currentBuild: build, builtAt: startedAt, algorithmVersion })
        .where(
          and(eq(conversationState.chatPk, chatKey), sql`coalesce(${conversationState.currentBuild}, 0) < ${build}`),
        )
        .run()
    }),
  )

  const current = sql`(SELECT ${conversationState.currentBuild} FROM ${conversationState}
    WHERE ${conversationState.chatPk} = ${chatKey})`
  await inTurns(
    context,
    (function* () {
      for (;;) {
        const removed =
          orm
            .delete(conversations)
            .where(
              sql`${conversations.pk} IN (SELECT ${conversations.pk} FROM ${conversations}
              WHERE ${conversations.chatPk} = ${chatKey} AND ${conversations.build} < ${current} LIMIT ${batch})`,
            )
            .returning({ pk: conversations.pk })
            .all().length +
          orm
            .delete(messageLinks)
            .where(
              sql`rowid IN (SELECT rowid FROM ${messageLinks} WHERE ${messageLinks.chatPk} = ${chatKey}
              AND ${messageLinks.build} < ${current} LIMIT ${batch})`,
            )
            .returning({ pk: messageLinks.messagePk })
            .all().length
        if (removed === 0) return
        yield
      }
    })(),
  )
}

const row = (link: Link, messagePk: number, parentPk: number) => ({
  messagePk,
  parentPk,
  source: link.source,
  kind: link.kind,
  confidence: link.confidence,
  method: link.method,
})

/** Only the build readers see; a newer one may be half written. */
const isCurrent = sql`${conversations.build} = (SELECT ${conversationState.currentBuild} FROM ${conversationState}
  WHERE ${conversationState.chatPk} = ${conversations.chatPk})`

const SUMMARY = {
  pk: conversations.pk,
  chatId: chats.nativeId,
  firstMessageId: messages.nativeId,
  firstAt: conversations.firstAt,
  lastAt: conversations.lastAt,
  messageCount: conversations.messageCount,
  builtAt: conversations.builtAt,
  algorithmVersion: conversations.algorithmVersion,
  senders: sql<number>`(SELECT count(DISTINCT coalesce(m.sender_chat_native_id, m.sender_identity_pk))
    FROM conversation_messages cm JOIN messages m ON m.pk = cm.message_pk WHERE cm.conversation_pk = ${conversations.pk})`,
}

const summaries = ({ orm }: StoreContext) =>
  orm
    .select(SUMMARY)
    .from(conversations)
    .innerJoin(chats, eq(chats.pk, conversations.chatPk))
    .innerJoin(messages, eq(messages.pk, conversations.firstMessagePk))

const toSummary = (row: {
  pk: number
  chatId: string
  firstMessageId: string
  firstAt: number
  lastAt: number
  messageCount: number
  builtAt: number
  algorithmVersion: number
  senders: number
}): ConversationSummary => ({
  id: String(row.pk),
  chatId: row.chatId,
  firstMessageId: row.firstMessageId,
  firstAt: toIso(row.firstAt) as string,
  lastAt: toIso(row.lastAt) as string,
  messageCount: row.messageCount,
  senders: Number(row.senders),
  builtAt: toIso(row.builtAt) as string,
  algorithmVersion: row.algorithmVersion,
})

/** Newest first. `after` and `before` bound when a conversation started. */
export const conversationPage = (
  context: StoreContext,
  chatKey: number,
  { limit, after, before }: { limit: number; after?: number; before?: number },
): { items: ConversationSummary[]; hasMore: boolean } => {
  const rows = summaries(context)
    .where(
      and(
        eq(conversations.chatPk, chatKey),
        isCurrent,
        after === undefined ? undefined : sql`${conversations.firstAt} >= ${after}`,
        before === undefined ? undefined : sql`${conversations.firstAt} < ${before}`,
      ),
    )
    .orderBy(desc(conversations.firstAt), desc(conversations.pk))
    .limit(limit + 1)
    .all()
  return { items: rows.slice(0, limit).map(toSummary), hasMore: rows.length > limit }
}

/** Its messages oldest first — only an account's own conversation. */
export const conversation = (
  context: StoreContext,
  accountKey: number,
  id: number,
): { summary: ConversationSummary; messages: Message[] } | undefined => {
  const found = summaries(context)
    .where(and(eq(conversations.pk, id), eq(chats.accountPk, accountKey), isCurrent))
    .get()
  if (!found) return undefined
  const rows = selectMessages(context)
    .where(
      and(
        isNull(messages.deletedAt),
        sql`${messages.pk} IN (SELECT ${conversationMessages.messagePk} FROM ${conversationMessages}
          WHERE ${conversationMessages.conversationPk} = ${id})`,
      ),
    )
    .orderBy(asc(messages.sentAt), asc(messages.pk))
    .all()
  return { summary: toSummary(found), messages: toMessages(context, rows) }
}

export const conversationOf = ({ orm }: StoreContext, chatKey: number, messageId: Id): string | undefined => {
  const found = orm
    .select({ pk: conversationMessages.conversationPk })
    .from(conversationMessages)
    .innerJoin(messages, eq(messages.pk, conversationMessages.messagePk))
    .innerJoin(conversations, eq(conversations.pk, conversationMessages.conversationPk))
    .where(and(eq(messages.chatPk, chatKey), eq(messages.nativeId, messageId), isCurrent))
    .get()
  return found ? String(found.pk) : undefined
}

/** Every link a message has, the messenger's first, then the strongest. */
export const linksOf = ({ orm }: StoreContext, chatKey: number, messageId: Id): StoredLink[] =>
  orm
    .select({
      parentId: sql<string | null>`(SELECT p.native_id FROM messages p WHERE p.pk = ${messageLinks.parentPk})`,
      source: messageLinks.source,
      kind: messageLinks.kind,
      confidence: messageLinks.confidence,
      method: messageLinks.method,
      version: messageLinks.version,
      createdAt: messageLinks.createdAt,
      staleAt: messageLinks.staleAt,
    })
    .from(messageLinks)
    .innerJoin(messages, eq(messages.pk, messageLinks.messagePk))
    .where(
      and(
        eq(messages.chatPk, chatKey),
        eq(messages.nativeId, messageId),
        sql`(${messageLinks.build} IS NULL OR ${messageLinks.build} = (SELECT ${conversationState.currentBuild}
          FROM ${conversationState} WHERE ${conversationState.chatPk} = ${chatKey}))`,
      ),
    )
    .orderBy(
      sql`CASE ${messageLinks.source} WHEN 'provider' THEN 0 WHEN 'agent' THEN 1 ELSE 2 END`,
      desc(messageLinks.confidence),
    )
    .all()
    .map(({ createdAt, staleAt, ...link }) => ({
      ...link,
      source: link.source as StoredLink["source"],
      createdAt: toIso(createdAt) as string,
      stale: staleAt !== null,
    }))

export const stateOf = ({ orm }: StoreContext, chatKey: number) => {
  const found = orm.select().from(conversationState).where(eq(conversationState.chatPk, chatKey)).get()
  return found
    ? {
        enabledAt: toIso(found.enabledAt) as string,
        builtAt: toIso(found.builtAt),
        algorithmVersion: found.algorithmVersion,
      }
    : undefined
}
