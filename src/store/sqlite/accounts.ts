import type { AccountKey } from "../store.js"
import { and, asc, eq, inArray, sql } from "./drizzle/core.js"
import type { StoreContext } from "./open.js"
import {
  accountIdentities,
  accounts,
  attachments,
  chatMembers,
  chats,
  fetchLeases,
  messageRevisions,
  messages,
  syncRanges,
  syncState,
  transcripts,
} from "./schema.js"

/** An account's row, made on first sight; a name only replaces what was known when there is one. */
export const accountPk = ({ orm, now }: StoreContext, { provider, account }: AccountKey, name: string | null = null) =>
  Number(
    orm
      .insert(accounts)
      .values({ provider, nativeId: account, name, createdAt: now() })
      .onConflictDoUpdate({
        target: [accounts.provider, accounts.nativeId],
        set: { name: sql`coalesce(excluded.name, ${accounts.name})` },
      })
      .returning({ pk: accounts.pk })
      .get()?.pk,
  )

export const findAccountPk = ({ orm }: StoreContext, { provider, account }: AccountKey): number | undefined =>
  orm
    .select({ pk: accounts.pk })
    .from(accounts)
    .where(and(eq(accounts.provider, provider), eq(accounts.nativeId, account)))
    .get()?.pk

export const heldAccounts = ({ orm }: StoreContext): AccountKey[] =>
  orm
    .select({ provider: accounts.provider, account: accounts.nativeId })
    .from(accounts)
    .orderBy(asc(accounts.provider), asc(accounts.nativeId))
    .all()

/** Everything the account holds, children before parents: the foreign keys are enforced. */
export const purgeAccount = ({ orm }: StoreContext, accountKey: number): void => {
  const chatsOf = orm.select({ pk: chats.pk }).from(chats).where(eq(chats.accountPk, accountKey))
  const messagesOf = orm.select({ pk: messages.pk }).from(messages).where(eq(messages.accountPk, accountKey))
  orm.delete(transcripts).where(inArray(transcripts.chatPk, chatsOf)).run()
  orm.delete(fetchLeases).where(inArray(fetchLeases.chatPk, chatsOf)).run()
  orm.delete(chatMembers).where(inArray(chatMembers.chatPk, chatsOf)).run()
  orm.delete(syncRanges).where(inArray(syncRanges.chatPk, chatsOf)).run()
  orm.delete(messageRevisions).where(inArray(messageRevisions.messagePk, messagesOf)).run()
  orm.delete(attachments).where(inArray(attachments.messagePk, messagesOf)).run()
  orm.delete(messages).where(eq(messages.accountPk, accountKey)).run()
  orm.delete(chats).where(eq(chats.accountPk, accountKey)).run()
  orm.delete(syncState).where(eq(syncState.accountPk, accountKey)).run()
  orm.delete(accountIdentities).where(eq(accountIdentities.accountPk, accountKey)).run()
  orm.delete(accounts).where(eq(accounts.pk, accountKey)).run()
}
