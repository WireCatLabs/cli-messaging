import { CliError } from "@leemour/cli-core"
import type { Contact, Id, Page, PersonAlias, Provider } from "../../domain/models.js"
import type { PeopleLookup } from "../../resolve.js"
import type { AccountKey, PersonFacts } from "../store.js"
import { ulid } from "../ulid.js"
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, sql } from "./drizzle/core.js"
import type { Orm, StoreContext } from "./open.js"
import {
  accountIdentities,
  accounts,
  chatMembers,
  chats,
  contactAliases,
  identities,
  identityLinkEvents,
  identityLinks,
  identityRevisions,
  messages,
  persons,
} from "./schema.js"
import { toIso } from "./values.js"

type Facts = Omit<PersonFacts, "id" | "name"> & {
  /** The messenger's marks, given only by a full profile read (a member list): its name and username are then the whole truth. */
  marks?: Record<string, boolean>
}

interface Profile {
  name: string | null
  username: string | null
  marks?: string | null
}

export interface SavedIdentity {
  pk: number
  /** The profile differs from an earlier one written. */
  revised: boolean
}

const flag = (value: boolean | null | undefined) => (value === undefined || value === null ? null : Number(value))

const prepare = (orm: Orm) => ({
  find: orm
    .select({
      pk: identities.pk,
      name: identities.name,
      username: identities.username,
      isBot: identities.isBot,
      description: identities.description,
      updatedAt: identities.updatedAt,
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
  lastRevision: orm
    .select({
      pk: identityRevisions.pk,
      name: identityRevisions.name,
      username: identityRevisions.username,
      marks: identityRevisions.marks,
    })
    .from(identityRevisions)
    .where(eq(identityRevisions.identityPk, sql.placeholder("identityPk")))
    .orderBy(desc(identityRevisions.capturedAt), desc(identityRevisions.pk))
    .limit(1)
    .prepare(),
})

// Built once per store: both run for every message saved, and building a Drizzle query costs more than running it.
const prepared = new WeakMap<Orm, ReturnType<typeof prepare>>()
const statementsOf = (orm: Orm) => {
  const statements = prepared.get(orm) ?? prepare(orm)
  prepared.set(orm, statements)
  return statements
}

const writeRevision = (orm: Orm, identityPk: number, { name, username, marks }: Profile, capturedAt: number) =>
  Number(
    orm
      .insert(identityRevisions)
      .values({ identityPk, name, username, marks: marks ?? null, capturedAt })
      .returning({ pk: identityRevisions.pk })
      .get()?.pk,
  )

/**
 * Writes a revision when the profile differs from the last one written; `before`, dated, goes first when there is
 * none yet. A revision written without marks gets them filled in rather than a second row: learning them is not a
 * change, and member history would report one.
 */
const revise = (orm: Orm, identity: number, next: Profile, at: number, before?: Profile & { at: number }): boolean => {
  let last = statementsOf(orm).lastRevision.get({ identityPk: identity })
  if (!last && before) last = { ...before, marks: null, pk: writeRevision(orm, identity, before, before.at) }
  const marks = next.marks ?? last?.marks ?? null
  if (last && last.name === next.name && last.username === next.username) {
    if (last.marks === marks) return false
    if (last.marks === null) {
      orm.update(identityRevisions).set({ marks }).where(eq(identityRevisions.pk, last.pk)).run()
      return false
    }
  }
  writeRevision(orm, identity, { ...next, marks }, at)
  return last !== undefined
}

/** Every new identity gets its own person; linking two is a later, recorded act. */
export const identityOf = (
  context: StoreContext,
  provider: Provider,
  nativeId: Id,
  name: string | null,
  facts: Facts = {},
): number => saveIdentity(context, provider, nativeId, name, facts).pk

const saveIdentity = (
  { orm, now }: StoreContext,
  provider: Provider,
  nativeId: Id,
  name: string | null,
  facts: Facts,
): SavedIdentity => {
  const found = statementsOf(orm).find.get({ provider, nativeId })
  const marks = facts.marks ? JSON.stringify(facts.marks) : undefined
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
    const renamed = changed.name !== found.name || changed.username !== found.username
    if (marks === undefined && !renamed) return { pk: found.pk, revised: false }
    const next = marks === undefined ? changed : { name, username: facts.username ?? null, marks }
    const before = renamed ? { name: found.name, username: found.username, at: found.updatedAt } : undefined
    return { pk: found.pk, revised: revise(orm, found.pk, next, now(), before) }
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
  if (marks !== undefined) revise(orm, identity, { name, username: facts.username ?? null, marks }, at)
  return { pk: identity, revised: false }
}

/** An identity as `accountKey` saw it — recorded as seen by that account, so reads stay per account. */
export const identityPk = (
  context: StoreContext,
  accountKey: number,
  provider: Provider,
  nativeId: Id,
  name: string | null,
  facts: Facts = {},
): number => seenIdentity(context, accountKey, provider, nativeId, name, facts).pk

export const seenIdentity = (
  context: StoreContext,
  accountKey: number,
  provider: Provider,
  nativeId: Id,
  name: string | null,
  facts: Facts = {},
): SavedIdentity => {
  const saved = saveIdentity(context, provider, nativeId, name, facts)
  statementsOf(context.orm).seen.run({ accountPk: accountKey, identityPk: saved.pk, firstSeenAt: context.now() })
  return saved
}

export const people = (
  { orm, database }: StoreContext,
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
  if (account !== undefined) {
    const aliases = database
      .prepare(
        "SELECT i.native_id AS id, ca.alias FROM contact_aliases ca JOIN identities i ON i.pk=ca.identity_pk JOIN accounts a ON a.pk=ca.account_pk WHERE a.provider=? AND a.native_id=?",
      )
      .all(provider, account)
    for (const row of aliases) {
      const person = everyone.find((one) => one.id === row.id)
      if (person && row.alias != null) {
        person.alias = String(row.alias)
        person.displayName = person.alias
      }
    }
  }
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
      : sql`(${identities.pk} IN (SELECT rowid FROM identities_fts WHERE identities_fts MATCH ${`"${query.trim().replaceAll('"', '""')}"`}) OR EXISTS (SELECT 1 FROM contact_aliases ca WHERE ca.account_pk=${accountKey} AND ca.identity_pk=${identities.pk} AND instr(ca.alias_folded, ${query.trim().toLowerCase()}) > 0))`,
  )
}

export const contacts = (
  { orm }: StoreContext,
  accountKey: number,
  key: AccountKey,
  { order, query, limit, offset = 0 }: { order: "recent" | "name"; query?: string; limit: number; offset?: number },
): Page<Contact> => {
  const byName = [
    sql`coalesce(${contactAliases.alias}, ${identities.name}) IS NULL`,
    sql`coalesce(${contactAliases.alias}, ${identities.name})`,
    identities.nativeId,
  ]
  const rows = orm
    .select({
      alias: contactAliases.alias,
      id: identities.nativeId,
      name: identities.name,
      username: identities.username,
      description: identities.description,
      lastMessagedAt: accountIdentities.lastMessagedAt,
    })
    .from(accountIdentities)
    .innerJoin(identities, eq(identities.pk, accountIdentities.identityPk))
    .leftJoin(
      contactAliases,
      and(eq(contactAliases.identityPk, identities.pk), eq(contactAliases.accountPk, accountKey)),
    )
    .where(contactsWhere(accountKey, key, query))
    .orderBy(...(order === "recent" ? [sql`${accountIdentities.lastMessagedAt} DESC NULLS LAST`] : []), ...byName)
    .limit(limit + 1)
    .offset(offset)
    .all()
  return {
    items: rows.slice(0, limit).map((row) =>
      (({ alias, ...rest }) => ({
        ...rest,
        lastMessagedAt: toIso(rest.lastMessagedAt),
        ...(alias === null ? {} : { alias, displayName: alias }),
      }))(row),
    ),
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

/**
 * Every name and username the account's store recorded for one person: profile revisions, then the names on their
 * messages that no revision holds. Grouped by identity, never by name, so two people who shared one stay apart.
 */
export const namesOf = ({ orm }: StoreContext, accountKey: number, provider: Provider, nativeId: Id): PersonAlias[] => {
  const person = orm
    .select({ pk: identities.pk })
    .from(identities)
    .innerJoin(accountIdentities, eq(accountIdentities.identityPk, identities.pk))
    .where(
      and(
        eq(identities.provider, provider),
        eq(identities.nativeId, nativeId),
        eq(accountIdentities.accountPk, accountKey),
      ),
    )
    .get()
  if (!person) return []
  const profile = new Map<string, PersonAlias>()
  const revisions = orm
    .select({ name: identityRevisions.name, username: identityRevisions.username, at: identityRevisions.capturedAt })
    .from(identityRevisions)
    .where(eq(identityRevisions.identityPk, person.pk))
    .orderBy(asc(identityRevisions.capturedAt), asc(identityRevisions.pk))
    .all()
  for (const { name, username, at } of revisions) {
    const key = JSON.stringify([name, username])
    const seen = toIso(at) as string
    const known = profile.get(key)
    if (known) known.lastSeenAt = seen
    else profile.set(key, { ...aliasOf(name, username), firstSeenAt: seen, lastSeenAt: seen, source: "profile" })
  }
  const named = new Set(revisions.map(({ name }) => name))
  const fromMessages = orm
    .select({
      name: messages.senderName,
      first: sql<number>`min(${messages.sentAt})`,
      last: sql<number>`max(${messages.sentAt})`,
    })
    .from(messages)
    .innerJoin(chats, eq(chats.pk, messages.chatPk))
    .where(
      and(
        eq(messages.senderIdentityPk, person.pk),
        eq(chats.accountPk, accountKey),
        isNull(messages.deletedAt),
        isNotNull(messages.senderName),
      ),
    )
    .groupBy(messages.senderName)
    .orderBy(asc(sql`min(${messages.sentAt})`))
    .all()
    .filter(({ name }) => !named.has(name))
    .map(({ name, first, last }) => ({
      ...aliasOf(name, null),
      firstSeenAt: toIso(first) as string,
      lastSeenAt: toIso(last) as string,
      source: "messages" as const,
    }))
  return [...profile.values(), ...fromMessages]
}

const aliasOf = (name: string | null, username: string | null) => ({
  ...(name === null ? {} : { name }),
  ...(username === null ? {} : { username }),
})
