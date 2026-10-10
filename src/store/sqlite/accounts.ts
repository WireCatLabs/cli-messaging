import type { AccountKey } from "../store.js"
import { and, asc, eq, inArray, sql } from "./drizzle/core.js"
import type { StoreContext } from "./open.js"
import {
  accountIdentities,
  accounts,
  aliases,
  botUpdates,
  chatMembers,
  chats,
  chunks,
  fetchLeases,
  involvements,
  memberCounts,
  memberStays,
  messageRevisions,
  messages,
  messageTranscripts,
  syncCursors,
  syncRanges,
  syncs,
} from "./schema.js"

/** An account's row, made on first sight; a name only replaces what was known when there is one. */
export const accountPk = (
  { orm, now }: StoreContext,
  { provider, account, scope }: AccountKey,
  name: string | null = null,
) =>
  Number(
    orm
      .insert(accounts)
      .values({ provider, externalId: account, name, scope: scope ?? "personal", createdAt: now(), updatedAt: now() })
      .onConflictDoUpdate({
        target: [accounts.provider, accounts.externalId],
        set: {
          scope: scope ?? sql`${accounts.scope}`,
          name: sql`coalesce(excluded.name, ${accounts.name})`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
      .returning({ pk: accounts.id })
      .get()?.pk,
  )

export const findAccountPk = ({ orm }: StoreContext, { provider, account }: AccountKey): number | undefined =>
  orm
    .select({ pk: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.provider, provider), eq(accounts.externalId, account)))
    .get()?.pk

export const accountName = ({ orm }: StoreContext, { provider, account }: AccountKey): string | null =>
  orm
    .select({ name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.provider, provider), eq(accounts.externalId, account)))
    .get()?.name ?? null

export const heldAccounts = ({ orm }: StoreContext): AccountKey[] =>
  orm
    .select({ provider: accounts.provider, account: accounts.externalId })
    .from(accounts)
    .orderBy(asc(accounts.provider), asc(accounts.externalId))
    .all()

/** Everything the account holds, children before parents: the foreign keys are enforced. */
export const purgeAccount = ({ orm }: StoreContext, accountKey: number): void => {
  const chatsOf = orm.select({ pk: chats.id }).from(chats).where(eq(chats.accountId, accountKey))
  const messagesOf = orm.select({ pk: messages.id }).from(messages).where(eq(messages.accountId, accountKey))
  orm.delete(botUpdates).where(eq(botUpdates.accountId, accountKey)).run()
  orm.delete(involvements).where(eq(involvements.accountId, accountKey)).run()
  orm.delete(chunks).where(eq(chunks.accountId, accountKey)).run()
  orm.delete(aliases).where(eq(aliases.accountId, accountKey)).run()
  orm.delete(syncs).where(eq(syncs.accountId, accountKey)).run()
  orm.delete(messageTranscripts).where(inArray(messageTranscripts.chatId, chatsOf)).run()
  orm.delete(fetchLeases).where(inArray(fetchLeases.chatId, chatsOf)).run()
  orm.delete(chatMembers).where(inArray(chatMembers.chatId, chatsOf)).run()
  orm.delete(memberStays).where(inArray(memberStays.chatId, chatsOf)).run()
  orm.delete(memberCounts).where(inArray(memberCounts.chatId, chatsOf)).run()
  orm.delete(syncRanges).where(inArray(syncRanges.chatId, chatsOf)).run()
  orm.delete(messageRevisions).where(inArray(messageRevisions.messageId, messagesOf)).run()
  orm.delete(messages).where(eq(messages.accountId, accountKey)).run()
  orm.delete(chats).where(eq(chats.accountId, accountKey)).run()
  orm.delete(syncCursors).where(eq(syncCursors.accountId, accountKey)).run()
  orm.delete(accountIdentities).where(eq(accountIdentities.accountId, accountKey)).run()
  orm.delete(accounts).where(eq(accounts.id, accountKey)).run()
}
