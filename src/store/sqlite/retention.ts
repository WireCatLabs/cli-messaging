import { createHash } from "node:crypto"
import { CliError } from "@leemour/cli-core"
import {
  RETENTION_TOLERANCE,
  type RetentionOptions,
  type RetentionStay,
  retentionCohorts,
  validateRetentionOptions,
} from "../../domain/retention.js"
import { calendarKey } from "../../services/messages-search.js"
import { chatCompleteness } from "./completeness.js"
import type { StoreContext } from "./open.js"

const iso = (at: number) => new Date(at).toISOString()
const week = (day: string) => {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7))
  return date.toISOString().slice(0, 10)
}
export const retentionQuery = (
  context: StoreContext,
  accountPk: number,
  chatPk: number,
  chatId: string,
  options: RetentionOptions,
  evidence?: { cohort: string; cursor?: string },
) => {
  validateRetentionOptions(options)
  if (options.cutoff > context.now()) throw new CliError("validation_error", "retention cutoff cannot be in the future")
  const { database } = context
  const count = Number(
    database
      .prepare("SELECT count(*) AS n FROM member_stays WHERE chat_pk=? AND joined_at BETWEEN ? AND ?")
      .get(chatPk, options.since, options.until)?.n ?? 0,
  )
  if (count > 10_000)
    throw new CliError("validation_error", "retention exceeds 10000 stays — narrow the join period", {
      reason: "query_limit",
      complete: false,
    })
  const dayOf = calendarKey(options.timezone, "day")
  const archive = chatCompleteness(context, accountPk, [chatId])[0]
  const raw = database
    .prepare(
      "SELECT s.pk,i.native_id AS person,s.identity_pk,s.joined_at,s.first_seen_at,s.last_seen_at,s.gone_at FROM member_stays s JOIN identities i ON i.pk=s.identity_pk WHERE s.chat_pk=? AND s.joined_at BETWEEN ? AND ? ORDER BY s.joined_at,s.pk",
    )
    .all(chatPk, options.since, options.until)
  const batchStatement = database.prepare(
    `SELECT b.pk,b.observed_at,b.complete,EXISTS(SELECT 1 FROM membership_batch_members bm WHERE bm.batch_pk=b.pk AND bm.stay_pk=?) AS present FROM membership_batches b WHERE b.chat_pk=? AND b.observed_at BETWEEN ? AND ? ORDER BY b.observed_at,b.pk LIMIT 1`,
  )
  const departureStatement = database.prepare(
    `SELECT b.observed_at FROM membership_batches b WHERE b.chat_pk=? AND b.complete=1 AND b.observed_at BETWEEN ? AND ? AND NOT EXISTS(SELECT 1 FROM membership_batch_members bm WHERE bm.batch_pk=b.pk AND bm.stay_pk=?) ORDER BY b.observed_at,b.pk LIMIT 1`,
  )
  const lastPositiveStatement = database.prepare(
    `SELECT max(b.observed_at) AS at FROM membership_batches b JOIN membership_batch_members bm ON bm.batch_pk=b.pk WHERE bm.stay_pk=? AND b.observed_at < ?`,
  )
  const activityStatement = database.prepare(
    `SELECT min(sent_at) AS at FROM messages WHERE chat_pk=? AND sender_identity_pk=? AND deleted_at IS NULL AND sent_at >= ? AND sent_at < ?`,
  )
  const stays: RetentionStay[] = raw.map((row) => {
    const joinedAt = Number(row.joined_at),
      pk = Number(row.pk),
      end = joinedAt + options.within
    const day = dayOf(joinedAt),
      cohort = options.by === "week" ? week(day) : day
    const absence = departureStatement.get(chatPk, Math.max(joinedAt, Number(row.first_seen_at)), options.cutoff, pk)
    const upper = absence ? Number(absence.observed_at) : null
    const positive = lastPositiveStatement.get(pk, upper ?? options.cutoff + 1)
    const lower = positive?.at === null || positive?.at === undefined ? null : Number(positive.at)
    const activityEnd = Math.min(end, options.cutoff + 1, upper ?? Number.POSITIVE_INFINITY)
    const first = activityStatement.get(chatPk, Number(row.identity_pk), joinedAt, activityEnd)?.at
    const covered =
      archive?.state === "complete" &&
      archive.fetchedAt !== null &&
      Date.parse(archive.fetchedAt) >= end &&
      end <= options.cutoff
    return {
      stay: pk,
      person: String(row.person),
      joinedAt: iso(joinedAt),
      cohort,
      checkpoints: options.checkpoints.map((checkpoint) => {
        const target = joinedAt + checkpoint
        if (target > options.cutoff)
          return {
            checkpoint,
            targetAt: iso(target),
            state: "pending",
            observedAt: null,
            lagMilliseconds: null,
            complete: null,
          }
        const batch = batchStatement.get(pk, chatPk, target, Math.min(target + RETENTION_TOLERANCE, options.cutoff))
        return {
          checkpoint,
          targetAt: iso(target),
          state: !batch
            ? "unknown"
            : Number(batch.present) === 1
              ? "present"
              : Number(batch.complete) === 1
                ? "absent"
                : "unknown",
          observedAt: batch ? iso(Number(batch.observed_at)) : null,
          lagMilliseconds: batch ? Number(batch.observed_at) - target : null,
          complete: batch ? Number(batch.complete) === 1 : null,
        }
      }),
      activity: {
        state:
          first !== null && first !== undefined
            ? "observed-message"
            : end > options.cutoff
              ? "pending"
              : "no-observed-message",
        firstMessageAt: first === null || first === undefined ? null : iso(Number(first)),
        windowEnd: iso(end),
        archiveCovered: covered === true,
      },
      departure: {
        after: lower === null ? null : iso(lower),
        atOrBefore: upper === null ? null : iso(upper),
        early:
          upper !== null && upper <= end
            ? "observed"
            : lower !== null && lower >= end
              ? "not-observed"
              : end > options.cutoff
                ? "pending"
                : "unknown",
      },
    }
  })
  const unknownJoin = Number(
    database
      .prepare(
        "SELECT count(*) AS n FROM member_stays WHERE chat_pk=? AND joined_at IS NULL AND first_seen_at BETWEEN ? AND ?",
      )
      .get(chatPk, options.since, options.until)?.n ?? 0,
  )
  const { limit: _limit, ...fixedOptions } = options
  const serialized = JSON.stringify({ options: fixedOptions, stays, unknownJoin, archive })
  if (Buffer.byteLength(serialized) > 8 * 1024 * 1024)
    throw new CliError("validation_error", "retention fingerprint exceeds 8 MiB — narrow the join period", {
      reason: "query_limit",
      complete: false,
    })
  const fingerprint = createHash("sha256").update(serialized).digest("hex")
  const cohorts = retentionCohorts(stays, options)
  const selected = evidence ? stays.filter((stay) => stay.cohort === evidence.cohort) : stays
  let offset = 0
  if (evidence?.cursor) {
    try {
      if (evidence.cursor.length > 4096) throw new Error("oversized cursor")
      const cursor = JSON.parse(Buffer.from(evidence.cursor, "base64url").toString()) as {
        offset: number
        fingerprint: string
        cohort: string
      }
      if (
        !Number.isSafeInteger(cursor.offset) ||
        cursor.offset < 0 ||
        cursor.offset > selected.length ||
        cursor.fingerprint !== fingerprint ||
        cursor.cohort !== evidence.cohort
      )
        throw new Error("changed selection")
      offset = cursor.offset
    } catch {
      throw new CliError("validation_error", "retention evidence changed or cursor is invalid — restart the report", {
        reason: "selection_changed",
      })
    }
  }
  const page: RetentionStay[] = []
  let bytes = 2
  for (const stay of selected.slice(offset, offset + options.limit)) {
    const size = Buffer.byteLength(JSON.stringify(stay)) + 1
    if (bytes + size > 64 * 1024) break
    bytes += size
    page.push(stay)
  }
  const next = offset + page.length
  const nextCursor =
    next < selected.length
      ? Buffer.from(JSON.stringify({ offset: next, fingerprint, cohort: evidence?.cohort ?? null })).toString(
          "base64url",
        )
      : null
  return {
    chatId,
    cutoff: iso(options.cutoff),
    options,
    items: cohorts.slice(0, options.limit),
    total: cohorts.length,
    included: Math.min(cohorts.length, options.limit),
    hasMore: cohorts.length > options.limit,
    unknownJoin,
    eligibleStays: stays.length,
    fingerprint,
    evidence: page,
    evidenceTotal: selected.length,
    nextCursor,
    byteLimit: 64 * 1024,
    quality: {
      membership: "observed_checkpoints" as const,
      toleranceMilliseconds: RETENTION_TOLERANCE,
      archive: archive ?? null,
      continuousSurvival: false,
      groupSilentRate: null,
    },
  }
}
export type RetentionResult = ReturnType<typeof retentionQuery>
