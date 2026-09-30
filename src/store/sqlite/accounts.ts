import type { AccountKey } from "../store.js"
import { and, eq, sql } from "./drizzle/core.js"
import type { StoreContext } from "./open.js"
import { accounts } from "./schema.js"

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
