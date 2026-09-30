import { CliError } from "@leemour/cli-core"
import type { Contact, Id, Page, Provider } from "../../domain/models.js"
import type { PeopleLookup } from "../../resolve.js"
import type { AccountKey, PersonFacts } from "../store.js"
import { ulid } from "../ulid.js"
import { and, eq, inArray, ne, sql } from "./drizzle/core.js"
import type { Orm, StoreContext } from "./open.js"
import {
  accountIdentities,
  accounts,
  chatMembers,
  chats,
  identities,
  identityLinkEvents,
  identityLinks,
  persons,
} from "./schema.js"
import { toIso } from "./values.js"

type Facts = Omit<PersonFacts, "id" | "name">

const flag = (value: boolean | null | undefined) => (value === undefined || value === null ? null : Number(value))

const prepare = (orm: Orm) => ({
  find: orm
    .select({
      pk: identities.pk,
      name: identities.name,
      username: identities.username,
      isBot: identities.isBot,
      description: identities.description,
    })
    .from(identities)
    .where(
      and(eq(identities.provider, sql.placeholder("provider")), eq(identities.nativeId, sql.placeholder("nativeId"))),
    )
    .prepare(),
  seen: orm
    .insert(accountIdentities)
    .values({
      accountPk: sql.placeholder("accountPk"),
      identityPk: sql.placeholder("identityPk"),
      firstSeenAt: sql.placeholder("firstSeenAt"),
    })
    .onConflictDoNothing()
    .prepare(),
})

// Built once per store: both run for every message saved, and building a Drizzle query costs more than running it.
const prepared = new WeakMap<Orm, ReturnType<typeof prepare>>()
const statementsOf = (orm: Orm) => {
  const statements = prepared.get(orm) ?? prepare(orm)
  prepared.set(orm, statements)
  return statements
}

/** Every new identity gets its own person; linking two is a later, recorded act. */
export const identityOf = (
  { orm, now }: StoreContext,
  provider: Provider,
  nativeId: Id,
  name: string | null,
  facts: Facts = {},
): number => {
  const found = statementsOf(orm).find.get({ provider, nativeId })
  if (found) {
    const changed = {
      name: name ?? found.name,
      username: facts.username ?? found.username,
      isBot: flag(facts.isBot) ?? found.isBot,
      description: facts.description ?? found.description,
    }
    // Only on a real change: the search trigger rewrites the index row on every update of `name`.
    if (
      changed.name !== found.name ||
      changed.username !== found.username ||
      changed.isBot !== found.isBot ||
      changed.description !== found.description
    ) {
      orm
        .update(identities)
        .set({ ...changed, updatedAt: now() })
        .where(eq(identities.pk, found.pk))
        .run()
    }
    return found.pk
  }
  const at = now()
  const identity = Number(
    orm
      .insert(identities)
      .values({
        provider,
        nativeId,
        name,
        username: facts.username ?? null,
        isBot: flag(facts.isBot),
        description: facts.description ?? null,
        firstSeenAt: at,
        updatedAt: at,
      })
      .returning({ pk: identities.pk })
      .get()?.pk,
  )
  const person = Number(
    orm
      .insert(persons)
      .values({ uid: ulid(at), name, createdAt: at, updatedAt: at })
      .returning({ pk: persons.pk })
      .get()?.pk,
  )
  orm
    .insert(identityLinks)
    .values({
      identityPk: identity,
      personPk: person,
      method: "initial",
      confidence: 1,
      linkedAt: at,
      linkedBy: "ingest",
    })
    .run()
  orm
    .insert(identityLinkEvents)
    .values({ identityPk: identity, fromPersonPk: null, toPersonPk: person, method: "initial", at, by: "ingest" })
    .run()
  return identity
}

/** An identity as `accountKey` saw it — recorded as seen by that account, so reads stay per account. */
export const identityPk = (
  context: StoreContext,
  accountKey: number,
  provider: Provider,
  nativeId: Id,
  name: string | null,
  facts: Facts = {},
): number => {
  const identity = identityOf(context, provider, nativeId, name, facts)
  statementsOf(context.orm).seen.run({ accountPk: accountKey, identityPk: identity, firstSeenAt: context.now() })
  return identity
}

export const people = (
  { orm }: StoreContext,
  provider: Provider,
  { account, accounts: native }: { account?: Id; accounts?: Id[] },
): PeopleLookup => {
  const within = native ?? (account === undefined ? undefined : [account])
  const seenBy =
    within &&
    orm
      .select({ pk: accountIdentities.identityPk })
      .from(accountIdentities)
      .innerJoin(accounts, eq(accounts.pk, accountIdentities.accountPk))
      .where(and(eq(accounts.provider, provider), inArray(accounts.nativeId, within)))
  const everyone: Contact[] = orm
    .select({ id: identities.nativeId, name: identities.name, username: identities.username })
    .from(identities)
    .where(and(eq(identities.provider, provider), seenBy ? inArray(identities.pk, seenBy) : undefined))
    .all()
    .map((row) => ({ ...row, description: null, lastMessagedAt: null }))
  const byId = new Map(everyone.map((person) => [person.id, person]))
  return { get: (id) => byId.get(id), all: () => everyone }
}

/** A contact: someone other than the account itself, in one of its one-to-one chats. */
const contactsWhere = (accountKey: number, key: AccountKey, query: string | undefined) => {
  if (query !== undefined && query.trim().length < 3) {
    throw new CliError("validation_error", `a contact search takes at least 3 characters, got "${query}"`)
  }
  return and(
    eq(accountIdentities.accountPk, accountKey),
    ne(identities.nativeId, key.account),
    sql`EXISTS (SELECT 1 FROM ${chatMembers} JOIN ${chats} ON ${chats.pk} = ${chatMembers.chatPk}
                WHERE ${chatMembers.identityPk} = ${identities.pk} AND ${chats.accountPk} = ${accountIdentities.accountPk}
                  AND ${chats.kind} = 'dialog')`,
    query === undefined
      ? undefined
      : sql`${identities.pk} IN (SELECT rowid FROM identities_fts WHERE identities_fts MATCH ${`"${query.trim().replaceAll('"', '""')}"`})`,
  )
}

export const contacts = (
  { orm }: StoreContext,
  accountKey: number,
  key: AccountKey,
  { order, query, limit, offset = 0 }: { order: "recent" | "name"; query?: string; limit: number; offset?: number },
): Page<Contact> => {
  const byName = [sql`${identities.name} IS NULL`, identities.name, identities.nativeId]
  const rows = orm
    .select({
      id: identities.nativeId,
      name: identities.name,
      username: identities.username,
      description: identities.description,
      lastMessagedAt: accountIdentities.lastMessagedAt,
    })
    .from(accountIdentities)
    .innerJoin(identities, eq(identities.pk, accountIdentities.identityPk))
    .where(contactsWhere(accountKey, key, query))
    .orderBy(...(order === "recent" ? [sql`${accountIdentities.lastMessagedAt} DESC NULLS LAST`] : []), ...byName)
    .limit(limit + 1)
    .offset(offset)
    .all()
  return {
    items: rows.slice(0, limit).map((row) => ({ ...row, lastMessagedAt: toIso(row.lastMessagedAt) })),
    hasMore: rows.length > limit,
  }
}

export const countContacts = (
  { orm }: StoreContext,
  accountKey: number,
  key: AccountKey,
  query: string | undefined,
): number =>
  Number(
    orm
      .select({ n: sql<number>`count(*)` })
      .from(accountIdentities)
      .innerJoin(identities, eq(identities.pk, accountIdentities.identityPk))
      .where(contactsWhere(accountKey, key, query))
      .get()?.n,
  )

export const refreshRecency = ({ orm }: StoreContext, accountKey: number): void => {
  orm
    .update(accountIdentities)
    .set({
      lastMessagedAt: sql`(SELECT max(${chats.lastMessageAt}) FROM ${chatMembers} JOIN ${chats} ON ${chats.pk} = ${chatMembers.chatPk}
        WHERE ${chatMembers.identityPk} = ${accountIdentities.identityPk} AND ${chats.accountPk} = ${accountIdentities.accountPk}
          AND ${chats.kind} = 'dialog')`,
    })
    .where(eq(accountIdentities.accountPk, accountKey))
    .run()
}
