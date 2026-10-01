import type { ChatKind, Id, Message, Reactions } from "../../domain/models.js"
import { NORMALIZER_VERSION, normalize } from "../normalize.js"
import type { AccountKey, DeletionScope } from "../store.js"
import { findChatPk } from "./chats.js"
import { and, eq, isNull, type Placeholder, sql } from "./drizzle/core.js"
import { identityPk } from "./identities.js"
import type { Orm, StoreContext } from "./open.js"
import { attachments, chats, messageRevisions, messages, transcripts } from "./schema.js"
import { json, parsed, toMs } from "./values.js"

const FIELDS = [
  "threadNativeId",
  "senderIdentityPk",
  "senderChatNativeId",
  "senderName",
  "sentAt",
  "editedAt",
  "replyToNativeId",
  "replyTo",
  "forward",
  "outgoing",
  "reactions",
  "providerMetadata",
  "mentions",
  "normalizedText",
  "normalizerVersion",
] as const

type Fields = Record<(typeof FIELDS)[number], string | number | null>

const ATTACHMENT_FIELDS = [
  "kind",
  "mime",
  "name",
  "title",
  "url",
  "size",
  "width",
  "height",
  "duration",
  "providerRef",
] as const

const placeholders = <const T extends string>(names: readonly T[]) =>
  Object.fromEntries(names.map((name) => [name, sql.placeholder(name)])) as Record<T, Placeholder<T>>

const prepare = (orm: Orm) => ({
  find: orm
    .select({ pk: messages.pk, text: messages.text, editedAt: messages.editedAt, deletedAt: messages.deletedAt })
    .from(messages)
    .where(and(eq(messages.chatPk, sql.placeholder("chatPk")), eq(messages.nativeId, sql.placeholder("nativeId"))))
    .prepare(),
  insert: orm
    .insert(messages)
    .values(placeholders(["chatPk", "accountPk", "nativeId", "text", "ingestedAt", "ingestedVia", ...FIELDS]))
    .returning({ pk: messages.pk })
    .prepare(),
  // A copy that knows less — no reactions asked for, no quote sent, no sender — never erases what we had.
  update: orm
    .update(messages)
    .set(
      Object.fromEntries(
        FIELDS.map((name) => [name, sql`coalesce(${sql.placeholder(name)}, ${messages[name]})`]),
      ) as Record<(typeof FIELDS)[number], ReturnType<typeof sql>>,
    )
    .where(eq(messages.pk, sql.placeholder("pk")))
    .prepare(),
  // Upserted by position, never replaced: a later fetch must not lose where the bytes were saved.
  attachment: orm
    .insert(attachments)
    .values(placeholders(["messagePk", "position", ...ATTACHMENT_FIELDS]))
    .onConflictDoUpdate({
      target: [attachments.messagePk, attachments.position],
      set: Object.fromEntries(
        ATTACHMENT_FIELDS.map((name) => [name, sql.raw(`excluded.${attachments[name].name}`)]),
      ) as Record<(typeof ATTACHMENT_FIELDS)[number], ReturnType<typeof sql.raw>>,
    })
    .prepare(),
})

// Built once per store: they run for every message saved, and building a Drizzle query costs more than running it.
const prepared = new WeakMap<Orm, ReturnType<typeof prepare>>()
const statementsOf = (orm: Orm) => {
  const statements = prepared.get(orm) ?? prepare(orm)
  prepared.set(orm, statements)
  return statements
}

const fieldsOf = (message: Message, sender: number | null): Fields => ({
  threadNativeId: message.threadId ?? null,
  senderIdentityPk: sender,
  senderChatNativeId: message.senderIsChat ? message.senderId : null,
  senderName: message.senderName,
  sentAt: toMs(message.timestamp) ?? 0,
  editedAt: toMs(message.editedAt),
  replyToNativeId: message.replyToId ?? message.replyTo?.id ?? null,
  replyTo: json(message.replyTo ?? undefined),
  forward: json(message.forwardedFrom ?? undefined),
  outgoing: message.outgoing === null ? null : Number(message.outgoing),
  reactions: json(message.reactions ?? undefined),
  providerMetadata: json(message.providerMetadata),
  mentions: message.mentions?.length ? JSON.stringify(message.mentions) : null,
  normalizedText: normalize(message.text),
  normalizerVersion: NORMALIZER_VERSION,
})

export const upsertMessage = (
  context: StoreContext,
  key: AccountKey,
  accountKey: number,
  chatKey: number,
  message: Message,
  via: string,
  seenAt?: number,
): void => {
  const { orm, now } = context
  const statements = statementsOf(orm)
  const sender =
    message.senderId === null || message.senderIsChat
      ? null
      : identityPk(
          context,
          accountKey,
          key.provider,
          message.senderId,
          message.senderName,
          message.senderUsername === undefined ? {} : { username: message.senderUsername },
        )
  const fields = fieldsOf(message, sender)

  const found = statements.find.get({ chatPk: chatKey, nativeId: message.id })
  const revived = found?.deletedAt != null && seenAt !== undefined && found.deletedAt < seenAt
  // A deleted message leaves no text behind, and a sync that still carries it does not bring it back.
  if (found?.deletedAt != null && !revived) return
  let pk: number
  if (!found) {
    pk = Number(
      statements.insert.get({
        chatPk: chatKey,
        accountPk: accountKey,
        nativeId: message.id,
        text: message.text,
        ingestedAt: now(),
        ingestedVia: via,
        ...fields,
      })?.pk,
    )
  } else {
    pk = found.pk
    statements.update.run({ ...fields, pk })
    // A tombstone emptied the text: there is no earlier version to keep.
    if (found.text !== message.text && !revived) {
      orm
        .insert(messageRevisions)
        .values({ messagePk: pk, text: found.text, editedAt: found.editedAt, capturedAt: now() })
        .run()
      orm.update(messages).set({ text: message.text }).where(eq(messages.pk, pk)).run()
    }
    if (revived) orm.update(messages).set({ deletedAt: null, text: message.text }).where(eq(messages.pk, pk)).run()
  }

  message.attachments.forEach((attachment, position) => {
    statements.attachment.run({
      messagePk: pk,
      position,
      kind: attachment.kind,
      mime: attachment.mime ?? null,
      name: attachment.name ?? null,
      title: attachment.title ?? null,
      url: attachment.url ?? null,
      size: attachment.size ?? null,
      width: attachment.width ?? null,
      height: attachment.height ?? null,
      duration: attachment.duration ?? null,
      providerRef: json(attachment.providerRef),
    })
  })
}

/**
 * The owner's ruling (NEED-393 A): a deleted message keeps its row, so a later sync cannot bring it
 * back, and leaves no text — not in the row, the search copy, the edit history or a transcript.
 */
export const tombstone = ({ orm, now }: StoreContext, pk: number): number => {
  const row = orm
    .update(messages)
    .set({ deletedAt: now(), text: "", normalizedText: null })
    .where(and(eq(messages.pk, pk), isNull(messages.deletedAt)))
    .returning({ chatPk: messages.chatPk, nativeId: messages.nativeId })
    .get()
  if (!row) return 0
  orm.delete(messageRevisions).where(eq(messageRevisions.messagePk, pk)).run()
  orm
    .delete(transcripts)
    .where(and(eq(transcripts.chatPk, row.chatPk), eq(transcripts.messageNativeId, row.nativeId)))
    .run()
  return 1
}

/** Whether the message is held at all. */
export const saveReactions = ({ orm }: StoreContext, chatKey: number, messageId: Id, reactions: Reactions): boolean =>
  orm
    .update(messages)
    .set({ reactions: JSON.stringify(reactions) })
    .where(and(eq(messages.chatPk, chatKey), eq(messages.nativeId, messageId)))
    .returning({ pk: messages.pk })
    .all().length > 0

export const markDeleted = (
  context: StoreContext,
  accountKey: number,
  messageIds: Id[],
  chatId: Id | undefined,
  among?: DeletionScope,
): number => {
  const { orm } = context
  const chatKey = chatId === undefined ? undefined : findChatPk(context, accountKey, chatId)
  let changed = 0
  for (const messageId of messageIds) {
    const live = and(eq(messages.accountPk, accountKey), eq(messages.nativeId, messageId), isNull(messages.deletedAt))
    if (chatId !== undefined) {
      const found =
        chatKey === undefined
          ? undefined
          : orm
              .select({ pk: messages.pk })
              .from(messages)
              .where(and(live, eq(messages.chatPk, chatKey)))
              .get()
      if (found) changed += tombstone(context, found.pk)
      continue
    }
    if (!among) continue
    // Two candidates left means the id is ambiguous, and a missed tombstone is better than a wrong one.
    const candidates = orm
      .select({ pk: messages.pk, id: chats.nativeId, kind: chats.kind, providerMetadata: chats.providerMetadata })
      .from(messages)
      .innerJoin(chats, eq(chats.pk, messages.chatPk))
      .where(live)
      .all()
      .filter(({ id, kind, providerMetadata }) =>
        among({ id, kind: kind as ChatKind, providerMetadata: parsed(providerMetadata) }),
      )
    if (candidates.length === 1 && candidates[0]) changed += tombstone(context, candidates[0].pk)
  }
  return changed
}
