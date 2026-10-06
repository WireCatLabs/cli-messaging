import type { Id } from "../domain/models.js"
import type { MemberStay, ProfileRevision } from "../store/store.js"

export interface MemberEvent {
  /** ISO 8601: when the store saw it — for a join, the messenger's own join time where it gave one. */
  at: string
  event: "joined" | "left" | "changed"
  id: Id
  name: string | null
  username: string | null
  /** `changed` only: what differed from the profile seen before. */
  before?: { name: string | null; username: string | null; marks: Record<string, boolean> }
  invitedBy?: Id
}

/**
 * Joins, leaves and profile changes, oldest first, from `since` (ms). A join before tracking began shows at
 * the messenger's join time when known; a leave is the first whole read without them.
 */
export const memberEvents = (stays: MemberStay[], revisions: ProfileRevision[], since = 0): MemberEvent[] => {
  const events: MemberEvent[] = []
  for (const stay of stays) {
    const person = { id: stay.id, name: stay.name, username: stay.username }
    events.push({
      at: stay.joinedAt ?? stay.firstSeenAt,
      event: "joined",
      ...person,
      ...(stay.invitedBy ? { invitedBy: stay.invitedBy } : {}),
    })
    if (stay.goneAt) events.push({ at: stay.goneAt, event: "left", ...person })
  }
  const last = new Map<Id, ProfileRevision>()
  for (const revision of revisions) {
    const before = last.get(revision.id)
    last.set(revision.id, revision)
    if (!before) continue
    events.push({
      at: revision.capturedAt,
      event: "changed",
      id: revision.id,
      name: revision.name,
      username: revision.username,
      before: { name: before.name, username: before.username, marks: before.marks },
    })
  }
  return events
    .filter(({ at }) => Date.parse(at) >= since)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id))
}
