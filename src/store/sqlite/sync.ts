import { and, eq, lte, or, sql } from "./drizzle/core.js"
import type { StoreContext } from "./open.js"
import { fetchLeases, syncState } from "./schema.js"
import { toIso } from "./values.js"

export const syncStateOf = ({ orm }: StoreContext, accountKey: number, name: string) => {
  const row = orm
    .select({ value: syncState.value, at: syncState.at })
    .from(syncState)
    .where(and(eq(syncState.accountPk, accountKey), eq(syncState.key, name)))
    .get()
  return row ? { value: row.value, at: toIso(row.at) as string } : undefined
}

export const writeState = ({ orm, now }: StoreContext, accountKey: number, name: string, value: string): void => {
  orm
    .insert(syncState)
    .values({ accountPk: accountKey, key: name, value, at: now() })
    .onConflictDoUpdate({
      target: [syncState.accountPk, syncState.key],
      set: { value: sql`excluded.value`, at: sql`excluded.at` },
    })
    .run()
}

export const clearState = ({ orm }: StoreContext, accountKey: number, name: string): void => {
  orm
    .delete(syncState)
    .where(and(eq(syncState.accountPk, accountKey), eq(syncState.key, name)))
    .run()
}

/** Taken when free, expired, or already this holder's; another holder's running lease stays. */
export const claim = (
  { orm, now }: StoreContext,
  chatKey: number,
  anchor: string,
  holder: string,
  forMs: number,
): boolean => {
  const at = now()
  return (
    orm
      .insert(fetchLeases)
      .values({ chatPk: chatKey, anchor, holder, expiresAt: at + forMs })
      .onConflictDoUpdate({
        target: [fetchLeases.chatPk, fetchLeases.anchor],
        set: { holder: sql`excluded.holder`, expiresAt: sql`excluded.expires_at` },
        setWhere: or(eq(fetchLeases.holder, sql`excluded.holder`), lte(fetchLeases.expiresAt, at)),
      })
      .returning({ chatPk: fetchLeases.chatPk })
      .all().length > 0
  )
}

export const release = ({ orm }: StoreContext, chatKey: number, anchor: string, holder: string): void => {
  orm
    .delete(fetchLeases)
    .where(and(eq(fetchLeases.chatPk, chatKey), eq(fetchLeases.anchor, anchor), eq(fetchLeases.holder, holder)))
    .run()
}
