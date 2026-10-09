import { CliError } from "@wirecat/cli-core"
import type { Chat, Id, Member, Page } from "../../domain/models.js"
import type { AccountKey, StoredChatFilter } from "../store.js"
import { and, eq, gt, inArray, or, sql } from "./drizzle/core.js"
import { identityPk } from "./identities.js"
import type { StoreContext } from "./open.js"
import {
  attachments,
  chatMembers,
  chats,
  fetchLeases,
  identities,
  memberCounts,
  memberStays,
  messageRevisions,
  messages,
  syncRanges,
  transcripts,
} from "./schema.js"
import { json, parsed, present, toIso, toMs } from "./values.js"

/** The chat's own id, when the store key is a chat of this account. */
export const chatOf = ({ orm }: StoreContext, accountKey: number, chatKey: number): Id | undefined =>
  orm
    .select({ id: chats.nativeId })
    .from(chats)
    .where(and(eq(chats.pk, chatKey), eq(chats.accountPk, accountKey)))
    .get()?.id

export const findChatPk = ({ orm }: StoreContext, accountKey: number, chatId: Id): number | undefined =>
  orm
    .select({ pk: chats.pk })
    .from(chats)
    .where(and(eq(chats.accountPk, accountKey), eq(chats.nativeId, chatId)))
    .get()?.pk

/** A chat known only from its messages, until the chat list names it. */
export const chatPkFor = (context: StoreContext, accountKey: number, chatId: Id): number =>
  findChatPk(context, accountKey, chatId) ??
  Number(
    context.orm
      .insert(chats)
      .values({ accountPk: accountKey, nativeId: chatId, kind: "unknown", updatedAt: context.now() })
      .returning({ pk: chats.pk })
      .get()?.pk,
  )

export const upsertChat = ({ orm, now }: StoreContext, accountKey: number, chat: Chat): void => {
  orm
    .insert(chats)
    .values({
      accountPk: accountKey,
      nativeId: chat.id,
      kind: chat.kind,
      title: chat.title,
      unreadCount: chat.unreadCount,
      lastMessageAt: toMs(chat.lastMessageAt),
      participantsCount: chat.participantsCount,
      providerMetadata: json(chat.providerMetadata),
      membershipState: chat.membershipState ?? null,
      updatedAt: now(),
    })
    .onConflictDoUpdate({
      target: [chats.accountPk, chats.nativeId],
      set: {
        kind: sql`excluded.kind`,
        title: sql`excluded.title`,
        unreadCount: sql`excluded.unread_count`,
        lastMessageAt: sql`excluded.last_message_at`,
        participantsCount: sql`excluded.participants_count`,
        providerMetadata: sql`excluded.provider_metadata`,
        // A chat the list names again has been rejoined; any other state it had is kept.
        membershipState: sql`CASE WHEN excluded.membership_state IS NOT NULL THEN excluded.membership_state
          WHEN ${chats.membershipState} = 'left' THEN NULL ELSE ${chats.membershipState} END`,
        updatedAt: sql`excluded.updated_at`,
      },
    })
    .run()
}

/** Replaces who is in the chat, whole. */
export const writeMembers = (
  context: StoreContext,
  key: AccountKey,
  accountKey: number,
  chatId: Id,
  memberIds: Id[],
): void => {
  const chatKey = chatPkFor(context, accountKey, chatId)
  context.orm.delete(chatMembers).where(eq(chatMembers.chatPk, chatKey)).run()
  for (const id of new Set(memberIds)) {
    context.orm
      .insert(chatMembers)
      .values({ chatPk: chatKey, identityPk: identityPk(context, accountKey, key.provider, id, null) })
      .run()
  }
}

export const members = ({ orm }: StoreContext, chatKey: number): Member[] =>
  orm
    .select({ id: identities.nativeId, name: identities.name, username: identities.username })
    .from(chatMembers)
    .innerJoin(identities, eq(identities.pk, chatMembers.identityPk))
    .where(eq(chatMembers.chatPk, chatKey))
    .orderBy(sql`${identities.name} IS NULL`, identities.name, identities.nativeId)
    .all()

const byRecency = [sql`${chats.lastMessageAt} DESC NULLS LAST`, chats.pk]

const notLeft = sql`${chats.membershipState} IS NOT 'left'`

/** Marks this account's chats that `present` does not name; only ever given a complete list. */
export const markLeft = ({ orm }: StoreContext, accountKey: number, present: Id[]): number =>
  orm
    .update(chats)
    .set({ membershipState: "left" })
    .where(
      and(
        eq(chats.accountPk, accountKey),
        notLeft,
        sql`${chats.nativeId} NOT IN (SELECT value FROM json_each(${JSON.stringify(present)}))`,
      ),
    )
    .returning({ pk: chats.pk })
    .all().length

/** The chats marked left, and how many messages they hold. */
export const leftChats = ({ orm }: StoreContext, accountKey: number): { pks: number[]; messages: number } => {
  const pks = orm
    .select({ pk: chats.pk })
    .from(chats)
    .where(and(eq(chats.accountPk, accountKey), eq(chats.membershipState, "left")))
    .all()
    .map(({ pk }) => pk)
  const count =
    pks.length === 0
      ? 0
      : Number(orm.select({ n: sql<number>`count(*)` }).from(messages).where(inArray(messages.chatPk, pks)).get()?.n)
  return { pks, messages: count }
}

/** These chats and everything under them, children before parents: the foreign keys are enforced. */
export const purgeChats = ({ orm }: StoreContext, pks: number[]): void => {
  if (pks.length === 0) return
  const messagesOf = orm.select({ pk: messages.pk }).from(messages).where(inArray(messages.chatPk, pks))
  orm.delete(transcripts).where(inArray(transcripts.chatPk, pks)).run()
  orm.delete(fetchLeases).where(inArray(fetchLeases.chatPk, pks)).run()
  orm.delete(chatMembers).where(inArray(chatMembers.chatPk, pks)).run()
  orm.delete(memberStays).where(inArray(memberStays.chatPk, pks)).run()
  orm.delete(memberCounts).where(inArray(memberCounts.chatPk, pks)).run()
  orm.delete(syncRanges).where(inArray(syncRanges.chatPk, pks)).run()
  orm.delete(messageRevisions).where(inArray(messageRevisions.messagePk, messagesOf)).run()
  orm.delete(attachments).where(inArray(attachments.messagePk, messagesOf)).run()
  orm.delete(messages).where(inArray(messages.chatPk, pks)).run()
  orm.delete(chats).where(inArray(chats.pk, pks)).run()
}

export const chatsWith = ({ orm }: StoreContext, accountKey: number, key: AccountKey, memberId: Id): Chat[] =>
  orm
    .select({ chat: chats })
    .from(chats)
    .where(
      and(
        eq(chats.accountPk, accountKey),
        notLeft,
        or(
          inArray(
            chats.pk,
            orm
              .select({ pk: chatMembers.chatPk })
              .from(chatMembers)
              .innerJoin(identities, eq(identities.pk, chatMembers.identityPk))
              .where(and(eq(identities.provider, key.provider), eq(identities.nativeId, memberId))),
          ),
          // Some providers name a private dialog by its partner's id without recording members.
          and(
            eq(chats.kind, "dialog"),
            eq(chats.nativeId, memberId),
            sql`NOT EXISTS (SELECT 1 FROM ${chatMembers} WHERE ${chatMembers.chatPk} = ${chats.pk})`,
          ),
        ),
      ),
    )
    .orderBy(...byRecency)
    .all()
    .map(({ chat }) => toChat(chat))

const chatsWhere = (accountKey: number, { query, kind, unread }: StoredChatFilter) => {
  if (query !== undefined && query.trim().length < 3) {
    throw new CliError("validation_error", `a chat search takes at least 3 characters, got "${query}"`)
  }
  return and(
    eq(chats.accountPk, accountKey),
    notLeft,
    query === undefined
      ? undefined
      : sql`${chats.pk} IN (SELECT rowid FROM chats_fts WHERE chats_fts MATCH ${`"${query.trim().replaceAll('"', '""')}"`})`,
    kind === undefined ? undefined : eq(chats.kind, kind),
    unread ? gt(chats.unreadCount, 0) : undefined,
  )
}

export const listChats = (
  { orm }: StoreContext,
  accountKey: number,
  { limit, offset = 0, ...filter }: { limit?: number; offset?: number } & StoredChatFilter,
): Page<Chat> => {
  const rows = orm
    .select()
    .from(chats)
    .where(chatsWhere(accountKey, filter))
    .orderBy(...byRecency)
    .limit(limit === undefined ? -1 : limit + 1)
    .offset(offset)
    .all()
  return { items: rows.slice(0, limit).map(toChat), hasMore: limit !== undefined && rows.length > limit }
}

export const countChats = ({ orm }: StoreContext, accountKey: number, filter: StoredChatFilter): number =>
  Number(orm.select({ n: sql<number>`count(*)` }).from(chats).where(chatsWhere(accountKey, filter)).get()?.n)

const toChat = (row: typeof chats.$inferSelect): Chat => ({
  id: row.nativeId,
  title: row.title,
  kind: row.kind as Chat["kind"],
  unreadCount: row.unreadCount,
  lastMessageAt: toIso(row.lastMessageAt),
  participantsCount: row.participantsCount,
  ...present({ membershipState: row.membershipState, providerMetadata: parsed(row.providerMetadata) }),
})
