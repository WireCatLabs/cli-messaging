import { CliError } from "@wirecat/cli-core"
import type { Attachment, ChatKind, Id, Message, Page, WindowedMessage } from "../../domain/models.js"
import type { ChatStats, SenderChatStats } from "../store.js"
import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, or, type SQL, sql } from "./drizzle/core.js"
import type { StoreContext } from "./open.js"
import { attachments, chats, identities, messageRevisions, messages } from "./schema.js"
import { parsed, present, toIso, toMs } from "./values.js"

/**
 * One flat row for every read, aliased where tables share a column name, so the same mapper serves
 * a plain select and a subquery (`find` per chat).
 */
export const MESSAGE_FIELDS = {
  pk: messages.pk,
  nativeId: messages.nativeId,
  chatNativeId: sql<string>`${chats.nativeId}`.as("chat_native_id"),
  senderNativeId: sql<string | null>`${identities.nativeId}`.as("sender_native_id"),
  senderChatNativeId: messages.senderChatNativeId,
  senderName: messages.senderName,
  sentAt: messages.sentAt,
  editedAt: messages.editedAt,
  text: messages.text,
  outgoing: messages.outgoing,
  replyTo: messages.replyTo,
  replyToNativeId: messages.replyToNativeId,
  forward: messages.forward,
  threadNativeId: messages.threadNativeId,
  reactions: messages.reactions,
  providerMetadata: messages.providerMetadata,
  mentions: messages.mentions,
}

export interface MessageRow {
  pk: number
  nativeId: string
  chatNativeId: string
  senderNativeId: string | null
  senderChatNativeId: string | null
  senderName: string | null
  sentAt: number
  editedAt: number | null
  text: string
  outgoing: number | null
  replyTo: string | null
  replyToNativeId: string | null
  forward: string | null
  threadNativeId: string | null
  reactions: string | null
  providerMetadata: string | null
  mentions: string | null
}

export const selectMessages = ({ orm }: StoreContext) =>
  orm
    .select(MESSAGE_FIELDS)
    .from(messages)
    .innerJoin(chats, eq(chats.pk, messages.chatPk))
    .leftJoin(identities, eq(identities.pk, messages.senderIdentityPk))

export const newestFirst = [desc(messages.sentAt), desc(messages.pk)]

export const before = (sentAt: number, pk: number) => sql`(${messages.sentAt}, ${messages.pk}) < (${sentAt}, ${pk})`

const after = (sentAt: number, pk: number) => sql`(${messages.sentAt}, ${messages.pk}) > (${sentAt}, ${pk})`

const live = (chatKey: number, ...conditions: (SQL | undefined)[]) =>
  and(eq(messages.chatPk, chatKey), isNull(messages.deletedAt), ...conditions)

export const toMessages = ({ orm }: StoreContext, rows: MessageRow[]): Message[] => {
  const byMessage = new Map<number, Attachment[]>()
  if (rows.length > 0) {
    const found = orm
      .select()
      .from(attachments)
      .where(
        inArray(
          attachments.messagePk,
          rows.map((row) => row.pk),
        ),
      )
      .orderBy(attachments.messagePk, attachments.position)
      .all()
    for (const row of found) byMessage.set(row.messagePk, [...(byMessage.get(row.messagePk) ?? []), toAttachment(row)])
  }
  return rows.map((row) => toMessage(row, byMessage.get(row.pk) ?? []))
}

export const countMessages = ({ orm }: StoreContext, chatKey: number, since: string | undefined): number =>
  Number(
    orm
      .select({ n: sql<number>`count(*)` })
      .from(messages)
      .where(live(chatKey, since === undefined ? undefined : gte(messages.sentAt, toMs(since) as number)))
      .get()?.n,
  )

/**
 * What changed in a chat after `at`, a time on this machine's clock: messages first saved or edited
 * since, oldest first, and the ids deleted since. Send time cannot answer it — an edit made today to
 * a message from last year was sent last year. A change to reactions alone leaves no time, so it is
 * not here.
 */
export const changesSince = (
  context: StoreContext,
  chatKey: number,
  at: number,
): { messages: Message[]; deleted: Id[] } => {
  const edited = context.orm
    .select({ pk: messageRevisions.messagePk })
    .from(messageRevisions)
    .where(gt(messageRevisions.capturedAt, at))
  const rows = selectMessages(context)
    .where(live(chatKey, or(gt(messages.ingestedAt, at), inArray(messages.pk, edited))))
    .orderBy(asc(messages.sentAt), asc(messages.pk))
    .all()
  const deleted = context.orm
    .select({ id: messages.nativeId })
    .from(messages)
    .where(and(eq(messages.chatPk, chatKey), gt(messages.deletedAt, at)))
    .orderBy(asc(messages.deletedAt), asc(messages.pk))
    .all()
  return { messages: toMessages(context, rows), deleted: deleted.map((row) => row.id) }
}

export const messagesWindow = (
  context: StoreContext,
  chatKey: number,
  { at, before: earlier, after: later }: { at: string; before: number; after: number },
): Message[] => {
  const moment = toMs(at) as number
  const older = selectMessages(context)
    .where(live(chatKey, lte(messages.sentAt, moment)))
    .orderBy(...newestFirst)
    .limit(earlier)
    .all()
  const newer = selectMessages(context)
    .where(live(chatKey, gt(messages.sentAt, moment)))
    .orderBy(asc(messages.sentAt), asc(messages.pk))
    .limit(later)
    .all()
  return toMessages(context, [...older.reverse(), ...newer])
}

export const messagePage = (
  context: StoreContext,
  chatKey: number,
  { limit, before: anchorId, since, threadId }: { limit: number; before?: Id; since?: string; threadId?: Id },
): Page<Message> => {
  const anchor =
    anchorId === undefined
      ? undefined
      : context.orm
          .select({ sentAt: messages.sentAt, pk: messages.pk })
          .from(messages)
          .where(and(eq(messages.chatPk, chatKey), eq(messages.nativeId, anchorId)))
          .get()
  if (anchorId !== undefined && !anchor) {
    throw new CliError("not_found", `message ${anchorId} is not in the local copy of this chat`)
  }
  const rows = selectMessages(context)
    .where(
      live(
        chatKey,
        anchor ? before(anchor.sentAt, anchor.pk) : undefined,
        since === undefined ? undefined : gte(messages.sentAt, toMs(since) as number),
        threadId === undefined ? undefined : eq(messages.threadNativeId, threadId),
      ),
    )
    .orderBy(...newestFirst)
    .limit(limit + 1)
    .all()
  return { items: toMessages(context, rows.slice(0, limit)).reverse(), hasMore: rows.length > limit }
}

export const around = (
  context: StoreContext,
  chatKey: number | undefined,
  messageId: Id,
  { before: earlier, after: later }: { before: number; after: number },
): WindowedMessage[] => {
  const anchor =
    chatKey === undefined
      ? undefined
      : selectMessages(context)
          .where(live(chatKey, eq(messages.nativeId, messageId)))
          .get()
  if (chatKey === undefined || !anchor) {
    throw new CliError("not_found", `message ${messageId} is not in the local copy of this chat`)
  }
  const side = (older: boolean, count: number) =>
    count === 0
      ? []
      : selectMessages(context)
          .where(live(chatKey, older ? before(anchor.sentAt, anchor.pk) : after(anchor.sentAt, anchor.pk)))
          .orderBy(...(older ? newestFirst : [asc(messages.sentAt), asc(messages.pk)]))
          .limit(count)
          .all()
  const rows = [...side(true, earlier).reverse(), anchor, ...side(false, later)]
  return toMessages(context, rows).map((message, index) =>
    rows[index]?.pk === anchor.pk ? { ...message, anchor: true } : message,
  )
}

export const message = (
  context: StoreContext,
  accountKey: number,
  messageId: Id,
  chatId: Id | undefined,
): Message | undefined => {
  const rows = selectMessages(context)
    .where(
      and(
        eq(messages.accountPk, accountKey),
        eq(messages.nativeId, messageId),
        isNull(messages.deletedAt),
        chatId === undefined ? undefined : eq(chats.nativeId, chatId),
      ),
    )
    .limit(2)
    .all()
  if (rows.length > 1) {
    throw new CliError("validation_error", `message ${messageId} is in more than one chat — name the chat`)
  }
  return toMessages(context, rows)[0]
}

export const chatStats = ({ orm }: StoreContext, accountKey: number, chatId: Id | undefined): ChatStats[] => {
  const newest = sql<number | null>`max(${messages.sentAt})`
  return orm
    .select({
      chatId: chats.nativeId,
      title: chats.title,
      messages: sql<number>`count(${messages.pk})`,
      oldest: sql<number | null>`min(${messages.sentAt})`,
      newest,
      stored: sql<number | null>`max(${messages.ingestedAt})`,
    })
    .from(chats)
    .innerJoin(messages, and(eq(messages.chatPk, chats.pk), isNull(messages.deletedAt)))
    .where(and(eq(chats.accountPk, accountKey), chatId === undefined ? undefined : eq(chats.nativeId, chatId)))
    .groupBy(chats.pk)
    .orderBy(desc(newest))
    .all()
    .map((row) => ({
      chatId: row.chatId,
      title: row.title,
      messages: Number(row.messages),
      oldestAt: toIso(row.oldest),
      newestAt: toIso(row.newest),
      lastStoredAt: toIso(row.stored),
    }))
}

/** One sender's stored messages per chat — count, first and last — in one grouped read. */
export const senderStats = (
  { orm }: StoreContext,
  accountKey: number,
  provider: string,
  senderId: Id,
): SenderChatStats[] => {
  const newest = sql<number | null>`max(${messages.sentAt})`
  return orm
    .select({
      chatId: chats.nativeId,
      title: chats.title,
      kind: chats.kind,
      messages: sql<number>`count(${messages.pk})`,
      oldest: sql<number | null>`min(${messages.sentAt})`,
      newest,
    })
    .from(messages)
    .innerJoin(chats, eq(chats.pk, messages.chatPk))
    .innerJoin(identities, eq(identities.pk, messages.senderIdentityPk))
    .where(
      and(
        eq(chats.accountPk, accountKey),
        isNull(messages.deletedAt),
        eq(identities.provider, provider),
        eq(identities.nativeId, senderId),
      ),
    )
    .groupBy(chats.pk)
    .orderBy(desc(newest))
    .all()
    .map((row) => ({
      chatId: row.chatId,
      title: row.title,
      kind: row.kind as ChatKind,
      messages: Number(row.messages),
      firstAt: toIso(row.oldest),
      lastAt: toIso(row.newest),
    }))
}

const toAttachment = (row: typeof attachments.$inferSelect): Attachment =>
  ({
    kind: row.kind,
    ...present({
      url: row.url,
      width: row.width,
      height: row.height,
      title: row.title,
      name: row.name,
      size: row.size,
      mime: row.mime,
      duration: row.duration,
      providerRef: parsed(row.providerRef),
    }),
  }) as Attachment

const toMessage = (row: MessageRow, attachments: Attachment[]): Message => {
  const senderChat = row.senderChatNativeId
  return {
    id: row.nativeId,
    chatId: row.chatNativeId,
    senderId: senderChat ?? row.senderNativeId ?? null,
    senderName: row.senderName,
    ...(senderChat ? { senderIsChat: true } : {}),
    timestamp: toIso(row.sentAt) as string,
    editedAt: toIso(row.editedAt),
    text: row.text,
    outgoing: row.outgoing === null ? null : row.outgoing === 1,
    attachments,
    replyTo: parsed(row.replyTo) ?? null,
    ...present({ replyToId: row.replyToNativeId }),
    forwardedFrom: parsed(row.forward) ?? null,
    ...present({ threadId: row.threadNativeId }),
    reactions: parsed(row.reactions) ?? null,
    ...present({ providerMetadata: parsed(row.providerMetadata), mentions: parsed(row.mentions) }),
  } as Message
}
