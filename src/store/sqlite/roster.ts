import { CliError } from "@leemour/cli-core"
import type { GroupMember, Id, Provider } from "../../domain/models.js"
import { and, asc, eq, gte, inArray, isNotNull, isNull, or, sql } from "./drizzle/core.js"
import { identityPk, seenIdentity } from "./identities.js"
import type { StoreContext } from "./open.js"
import { chatMembers, chats, identities, identityRevisions, memberCounts, memberStays } from "./schema.js"

export interface RosterRead {
  observation?: { observedAt: string; startedAt?: string; source: "remote_fetch" | "remote_update" }
  members: GroupMember[]
  /** Every member was read: only then can someone missing be recorded as gone. */
  complete: boolean
  /** The messenger's own count, where it gave one. */
  participants: number | null
}

export interface RosterChange {
  joined: Id[]
  gone: Id[]
  /** Whose profile differs from the one last seen. */
  changed: Id[]
}

export interface MemberStay {
  id: Id
  name: string | null
  username: string | null
  /** ISO 8601. */
  firstSeenAt: string
  lastSeenAt: string
  joinedAt: string | null
  invitedBy: Id | null
  role: string | null
  goneAt: string | null
}

export interface MemberCount {
  day: string
  participants: number | null
  listed: number
  complete: boolean
}

export interface ProfileRevision {
  id: Id
  name: string | null
  username: string | null
  description: string | null
  marks: Record<string, boolean>
  capturedAt: string
}

export interface TrackedChat {
  chatId: Id
  title: string | null
  trackedAt: string
  lastCount: MemberCount | null
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())

const marksOf = ({ isBot, flagged, deleted, hasPhoto }: GroupMember): Record<string, boolean> => ({
  ...(isBot === undefined ? {} : { bot: isBot }),
  ...(flagged === undefined ? {} : { [flagged]: true }),
  ...(deleted === undefined ? {} : { deleted }),
  ...(hasPhoto === undefined ? {} : { photo: hasPhoto }),
})

/** Stays opened, closed and kept, profiles revised, today's count — one read of a member list, in one transaction. */
export const saveRoster = (
  context: StoreContext,
  accountKey: number,
  provider: Provider,
  chatKey: number,
  { members, complete, participants, observation }: RosterRead,
): RosterChange => {
  const { orm, now } = context
  const at = now()
  const observedAt = observation ? Date.parse(observation.observedAt) : at
  const startedAt = observation?.startedAt ? Date.parse(observation.startedAt) : null
  if (
    observation &&
    (!Number.isSafeInteger(observedAt) ||
      observedAt < 0 ||
      observedAt > at ||
      (startedAt !== null && (!Number.isSafeInteger(startedAt) || startedAt < 0 || startedAt > observedAt)) ||
      !["remote_fetch", "remote_update"].includes(observation.source))
  )
    throw new CliError("validation_error", "member observation requires a valid nonfuture timestamp and remote source")
  const latest = context.database
    .prepare("SELECT max(max(last_seen_at,coalesce(gone_at,last_seen_at))) AS at FROM member_stays WHERE chat_pk=?")
    .get(chatKey)
  if (observation && latest?.at !== null && latest?.at !== undefined && observedAt < Number(latest.at))
    throw new CliError("validation_error", "member observation predates the latest saved roster")
  if (new Set(members.map((member) => member.id)).size !== members.length)
    throw new CliError("validation_error", "member roster contains duplicate identities")
  const batch = observation
    ? Number(
        context.database
          .prepare(
            "INSERT INTO membership_batches(chat_pk,observed_at,started_at,complete,participants,listed,source) VALUES(?,?,?,?,?,?,?) RETURNING pk",
          )
          .get(chatKey, observedAt, startedAt, complete ? 1 : 0, participants, members.length, observation.source)?.pk,
      )
    : undefined
  const recordMember = (person: number, stay: number) => {
    if (batch !== undefined)
      context.database
        .prepare(
          "INSERT INTO membership_batch_members(batch_pk,identity_pk,stay_pk) VALUES(?,?,?) ON CONFLICT DO NOTHING",
        )
        .run(batch, person, stay)
  }
  const change: RosterChange = { joined: [], gone: [], changed: [] }
  const present = new Set<number>()

  for (const member of members) {
    const { pk: person, revised } = seenIdentity(context, accountKey, provider, member.id, member.name, {
      username: member.username,
      ...(member.isBot === undefined ? {} : { isBot: member.isBot }),
      marks: marksOf(member),
    })
    present.add(person)
    if (revised) change.changed.push(member.id)

    const open = orm
      .select({ pk: memberStays.pk, joinedAt: memberStays.joinedAt, lastSeenAt: memberStays.lastSeenAt })
      .from(memberStays)
      .where(and(eq(memberStays.chatPk, chatKey), eq(memberStays.identityPk, person), isNull(memberStays.goneAt)))
      .get()
    const parsedJoin = member.joinedAt ? Date.parse(member.joinedAt) : Number.NaN
    const joinedAt = Number.isSafeInteger(parsedJoin) && parsedJoin >= 0 && parsedJoin <= observedAt ? parsedJoin : null
    const rejoined =
      open && joinedAt !== null && open.joinedAt !== null && joinedAt !== open.joinedAt && joinedAt > open.lastSeenAt
    if (rejoined) orm.update(memberStays).set({ goneAt: joinedAt }).where(eq(memberStays.pk, open.pk)).run()
    if (open && !rejoined) {
      orm
        .update(memberStays)
        .set({ lastSeenAt: observedAt, role: member.role ?? null, joinedAt: joinedAt ?? open.joinedAt })
        .where(eq(memberStays.pk, open.pk))
        .run()
      recordMember(person, open.pk)
      continue
    }
    const invitedBy = member.invitedBy ? identityPk(context, accountKey, provider, member.invitedBy, null) : null
    const inserted = orm
      .insert(memberStays)
      .values({
        chatPk: chatKey,
        identityPk: person,
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
        joinedAt,
        invitedByPk: invitedBy,
        role: member.role ?? null,
      })
      .returning({ pk: memberStays.pk })
      .get()
    if (inserted) recordMember(person, inserted.pk)
    change.joined.push(member.id)
  }

  if (complete) {
    const missing = orm
      .select({ pk: memberStays.pk, person: memberStays.identityPk, id: identities.nativeId })
      .from(memberStays)
      .innerJoin(identities, eq(identities.pk, memberStays.identityPk))
      .where(and(eq(memberStays.chatPk, chatKey), isNull(memberStays.goneAt)))
      .all()
      .filter(({ person }) => !present.has(person))
    for (const { pk, id } of missing) {
      orm.update(memberStays).set({ goneAt: observedAt }).where(eq(memberStays.pk, pk)).run()
      change.gone.push(id)
    }
    orm.delete(chatMembers).where(eq(chatMembers.chatPk, chatKey)).run()
    for (const person of present) orm.insert(chatMembers).values({ chatPk: chatKey, identityPk: person }).run()
  }

  const day = new Date(at).toISOString().slice(0, 10)
  const count = { participants, listed: members.length, complete: complete ? 1 : 0, at }
  orm
    .insert(memberCounts)
    .values({ chatPk: chatKey, day, ...count })
    .onConflictDoUpdate({ target: [memberCounts.chatPk, memberCounts.day], set: count })
    .run()
  return change
}

/** Every stay that was open at `since` or began after it, oldest first; all of them without `since`. */
export const memberStaysOf = ({ orm }: StoreContext, chatKey: number, since?: number): MemberStay[] =>
  orm
    .select({
      id: identities.nativeId,
      name: identities.name,
      username: identities.username,
      firstSeenAt: memberStays.firstSeenAt,
      lastSeenAt: memberStays.lastSeenAt,
      joinedAt: memberStays.joinedAt,
      invitedBy: sql<string | null>`(SELECT native_id FROM identities i WHERE i.pk = ${memberStays.invitedByPk})`,
      role: memberStays.role,
      goneAt: memberStays.goneAt,
    })
    .from(memberStays)
    .innerJoin(identities, eq(identities.pk, memberStays.identityPk))
    .where(
      and(
        eq(memberStays.chatPk, chatKey),
        since === undefined ? undefined : or(isNull(memberStays.goneAt), gte(memberStays.goneAt, since)),
      ),
    )
    .orderBy(asc(memberStays.firstSeenAt), asc(memberStays.pk))
    .all()
    .map((row) => ({
      ...row,
      firstSeenAt: iso(row.firstSeenAt) as string,
      lastSeenAt: iso(row.lastSeenAt) as string,
      joinedAt: iso(row.joinedAt),
      goneAt: iso(row.goneAt),
    }))

export const memberCountsOf = ({ orm }: StoreContext, chatKey: number, since?: string): MemberCount[] =>
  orm
    .select({
      day: memberCounts.day,
      participants: memberCounts.participants,
      listed: memberCounts.listed,
      complete: memberCounts.complete,
    })
    .from(memberCounts)
    .where(and(eq(memberCounts.chatPk, chatKey), since === undefined ? undefined : gte(memberCounts.day, since)))
    .orderBy(asc(memberCounts.day))
    .all()
    .map((row) => ({ ...row, complete: row.complete === 1 }))

/** Profiles of the chat's members, every revision, oldest first. */
export const profileRevisionsOf = ({ orm }: StoreContext, chatKey: number, since?: number): ProfileRevision[] => {
  const people = orm
    .selectDistinct({ pk: memberStays.identityPk })
    .from(memberStays)
    .where(eq(memberStays.chatPk, chatKey))
  return orm
    .select({
      id: identities.nativeId,
      name: identityRevisions.name,
      username: identityRevisions.username,
      description: identityRevisions.description,
      marks: identityRevisions.marks,
      capturedAt: identityRevisions.capturedAt,
    })
    .from(identityRevisions)
    .innerJoin(identities, eq(identities.pk, identityRevisions.identityPk))
    .where(
      and(
        inArray(identityRevisions.identityPk, people),
        since === undefined ? undefined : gte(identityRevisions.capturedAt, since),
      ),
    )
    .orderBy(asc(identityRevisions.capturedAt), asc(identityRevisions.pk))
    .all()
    .map((row) => ({
      ...row,
      marks: row.marks ? (JSON.parse(row.marks) as Record<string, boolean>) : {},
      capturedAt: iso(row.capturedAt) as string,
    }))
}

export const setTracked = ({ orm, now }: StoreContext, chatKey: number, tracked: boolean): void => {
  orm
    .update(chats)
    .set({ membersTrackedAt: tracked ? sql`coalesce(${chats.membersTrackedAt}, ${now()})` : null })
    .where(eq(chats.pk, chatKey))
    .run()
}

export const trackedChats = (context: StoreContext, accountKey: number): TrackedChat[] =>
  context.orm
    .select({ pk: chats.pk, chatId: chats.nativeId, title: chats.title, trackedAt: chats.membersTrackedAt })
    .from(chats)
    .where(and(eq(chats.accountPk, accountKey), isNotNull(chats.membersTrackedAt)))
    .orderBy(asc(chats.membersTrackedAt))
    .all()
    .map(({ pk, chatId, title, trackedAt }) => ({
      chatId,
      title,
      trackedAt: iso(trackedAt) as string,
      lastCount: memberCountsOf(context, pk).at(-1) ?? null,
    }))
