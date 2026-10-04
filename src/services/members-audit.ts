import type { GroupMember, Id, Message } from "../domain/models.js"
import type { ChatCompleteness } from "../store/store.js"

export const AUDIT_PAGE = 200
export const AUDIT_BUDGET = 10
export const AUDIT_PAUSE_MS = 1000
export const AUDIT_MIN_SCORE = 2
/** This many joining within `BURST_MINUTES` of each other is a burst. */
const BURST_SIZE = 5
const BURST_MINUTES = 10
/** One person who is not an admin bringing in this many is worth a look. */
const MASS_INVITES = 5

export type AuditReason =
  | "bot"
  | "scam"
  | "fake"
  | "deleted"
  | "no_photo"
  | "no_username"
  | "odd_name"
  | "never_wrote"
  | "link_first"
  | "burst_join"
  | "mass_invited"

const WEIGHTS: Record<AuditReason, number> = {
  bot: 3,
  scam: 3,
  fake: 3,
  deleted: 1,
  no_photo: 1,
  no_username: 1,
  odd_name: 1,
  never_wrote: 1,
  link_first: 2,
  burst_join: 1,
  mass_invited: 1,
}

export interface AuditedMember {
  id: Id
  name: string | null
  username: string | null
  score: number
  reasons: AuditReason[]
  joinedAt?: string | null
  invitedBy?: Id | null
}

export interface MembersAudit {
  chatId: Id
  /** Members read from the messenger, owner and admins included. */
  read: number
  /** The chat's own count, where the store has it. */
  participantsCount: number | null
  /** The budget or the messenger's own cap stopped the read: some members were not judged. */
  more: boolean
  /** Signals no member in the list could carry — the messenger does not say, or the store holds no messages. */
  unknown: AuditReason[]
  completeness?: ChatCompleteness
  fetch?: string
  /** Highest score first; only those at `minScore` or above. Owner and admins are never in it. */
  items: AuditedMember[]
}

const LINK = /https?:\/\/|t\.me\/|www\./i
const DIGITS = /\d{5,}/

/**
 * Scores each member from what the list and the store already hold. Never a verdict: real people
 * without a photo or a username are common, which is why each signal is light and the reasons are listed.
 */
export const auditMembers = (
  members: GroupMember[],
  { firstMessages, self, minScore }: { firstMessages: Map<Id, Message> | undefined; self: Id | null; minScore: number },
): { items: AuditedMember[]; unknown: AuditReason[] } => {
  const staff = new Set(members.filter(({ role }) => role === "owner" || role === "admin").map(({ id }) => id))
  if (self) staff.add(self)
  const someHaveUsernames = members.some(({ username }) => username)
  const bursts = burstJoins(members)
  const invites = new Map<Id, number>()
  for (const { invitedBy } of members) if (invitedBy) invites.set(invitedBy, (invites.get(invitedBy) ?? 0) + 1)

  const reasonsOf = (member: GroupMember): AuditReason[] => {
    const first = firstMessages?.get(member.id)
    const reasons: (AuditReason | false)[] = [
      member.isBot === true && "bot",
      member.flagged === "scam" && "scam",
      member.flagged === "fake" && "fake",
      member.deleted === true && "deleted",
      member.hasPhoto === false && "no_photo",
      someHaveUsernames && !member.username && "no_username",
      oddName(member.name) && "odd_name",
      firstMessages !== undefined && !first && "never_wrote",
      first !== undefined && (first.forwardedFrom !== null || LINK.test(first.text)) && "link_first",
      bursts.has(member.id) && "burst_join",
      !!member.invitedBy &&
        !staff.has(member.invitedBy) &&
        (invites.get(member.invitedBy) ?? 0) >= MASS_INVITES &&
        "mass_invited",
    ]
    return reasons.filter((one): one is AuditReason => one !== false)
  }

  const items = members
    .filter(({ id }) => !staff.has(id))
    .map((member) => {
      const reasons = reasonsOf(member)
      return {
        id: member.id,
        name: member.name,
        username: member.username,
        score: reasons.reduce((total, reason) => total + WEIGHTS[reason], 0),
        reasons,
        ...(member.joinedAt === undefined ? {} : { joinedAt: member.joinedAt }),
        ...(member.invitedBy === undefined ? {} : { invitedBy: member.invitedBy }),
      }
    })
    .filter(({ score }) => score >= minScore)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))

  const carried = (field: keyof GroupMember) => members.some((member) => member[field] !== undefined)
  const unknown: AuditReason[] = [
    ...(carried("isBot") ? [] : (["bot"] as const)),
    ...(carried("flagged") ? [] : (["scam", "fake"] as const)),
    ...(carried("deleted") ? [] : (["deleted"] as const)),
    ...(carried("hasPhoto") ? [] : (["no_photo"] as const)),
    ...(firstMessages === undefined ? (["never_wrote", "link_first"] as const) : []),
    ...(carried("joinedAt") ? [] : (["burst_join"] as const)),
    ...(carried("invitedBy") ? [] : (["mass_invited"] as const)),
  ]
  return { items, unknown }
}

const oddName = (name: string | null) => !name?.trim() || DIGITS.test(name) || LINK.test(name)

/** Members whose join falls in a run of `BURST_SIZE` or more, each within `BURST_MINUTES` of the next. */
const burstJoins = (members: GroupMember[]): Set<Id> => {
  const joined = members
    .flatMap(({ id, joinedAt }) => (joinedAt ? [{ id, at: Date.parse(joinedAt) }] : []))
    .sort((a, b) => a.at - b.at)
  const found = new Set<Id>()
  let run: typeof joined = []
  const close = () => {
    if (run.length >= BURST_SIZE) for (const { id } of run) found.add(id)
  }
  for (const one of joined) {
    const last = run.at(-1)
    if (last && one.at - last.at > BURST_MINUTES * 60_000) {
      close()
      run = []
    }
    run.push(one)
  }
  close()
  return found
}
