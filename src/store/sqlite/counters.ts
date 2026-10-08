import { CliError } from "@leemour/cli-core"
import {
  COUNTER_FIELDS,
  type CounterField,
  type CounterObservations,
  type CounterState,
  counterObservationTime,
  validCounter,
} from "../../domain/counters.js"
import { formatLocator } from "../../domain/locator.js"
import type { QueryExecution } from "../../search/lucene/resolved.js"
import { withQuerySelection } from "./lucene.js"
import type { StoreContext } from "./open.js"

function invalidMetadata(): never {
  throw new CliError("validation_error", "stored counter metadata is malformed — check the store before refreshing")
}
export const counterStates = (
  { database }: StoreContext,
  messagePk: number,
  now: number,
  maxAge: number,
): CounterState[] => {
  const row = database
    .prepare("SELECT reactions,provider_metadata FROM messages WHERE pk=? AND deleted_at IS NULL")
    .get(messagePk)
  if (!row) return []
  const parse = (raw: unknown): Record<string, unknown> => {
    try {
      const value: unknown = JSON.parse(String(raw ?? "{}"))
      return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }
  const metadata = parse(row.provider_metadata),
    reactions = parse(row.reactions)
  const records = database
    .prepare("SELECT counter,value,observed_at,source FROM message_counter_observations WHERE message_pk=?")
    .all(messagePk)
  return COUNTER_FIELDS.map((counter) => {
    const raw = counter === "reactions" ? reactions.total : metadata[counter]
    const value = validCounter(raw) ? raw : null
    const record = records.find((one) => one.counter === counter)
    const at = record && Number(record.value) === value ? Number(record.observed_at) : Number.NaN
    const known =
      Number.isSafeInteger(at) &&
      at >= 0 &&
      at <= now &&
      ["remote_fetch", "remote_update"].includes(String(record?.source))
    const age = known ? now - at : null
    return {
      counter,
      value,
      observedAt: known ? new Date(at).toISOString() : null,
      source: known ? (String(record?.source) as "remote_fetch" | "remote_update") : null,
      ageMilliseconds: age,
      freshness: age === null ? "unknown" : age > maxAge ? "stale" : "fresh",
    }
  })
}
export const applyCounterObservations = (
  context: StoreContext,
  messagePk: number,
  observations: CounterObservations,
): number => {
  const { database, now } = context
  const validated = Object.entries(observations).map(([field, observation]) => {
    if (!(COUNTER_FIELDS as readonly string[]).includes(field) || !observation)
      throw new CliError("validation_error", "unknown counter observation field")
    return { field: field as CounterField, observation, at: counterObservationTime(observation, now()) }
  })
  if (!validated.length) return 0
  const message = database
    .prepare("SELECT provider_metadata,reactions FROM messages WHERE pk=? AND deleted_at IS NULL")
    .get(messagePk)
  if (!message) return 0
  const object = (raw: unknown): Record<string, unknown> => {
    if (raw === null || raw === undefined) return {}
    try {
      const value: unknown = JSON.parse(String(raw))
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
    } catch {
      invalidMetadata()
    }
    return invalidMetadata()
  }
  const metadata = validated.some((one) => one.field !== "reactions") ? object(message.provider_metadata) : {}
  let reactions = message.reactions === null ? null : String(message.reactions)
  let updated = 0
  for (const { field, observation, at } of validated) {
    const existing = database
      .prepare("SELECT value,observed_at FROM message_counter_observations WHERE message_pk=? AND counter=?")
      .get(messagePk, field)
    const oldWins = existing && Number(existing.observed_at) > at
    const value = oldWins ? Number(existing.value) : observation.value
    if (field === "reactions") {
      if (!oldWins && observation.reactions) reactions = JSON.stringify(observation.reactions)
      else reactions = JSON.stringify({ total: value, mine: null, counts: [] })
    } else metadata[field] = value
    if (oldWins) continue
    database
      .prepare(
        "INSERT INTO message_counter_observations(message_pk,counter,value,observed_at,source) VALUES(?,?,?,?,?) ON CONFLICT(message_pk,counter) DO UPDATE SET value=excluded.value,observed_at=excluded.observed_at,source=excluded.source",
      )
      .run(messagePk, field, value, at, observation.source)
    updated++
  }
  if (validated.length)
    database
      .prepare("UPDATE messages SET provider_metadata=?,reactions=? WHERE pk=? AND deleted_at IS NULL")
      .run(
        validated.some((one) => one.field !== "reactions")
          ? JSON.stringify(metadata)
          : message.provider_metadata === null
            ? null
            : String(message.provider_metadata),
        reactions,
        messagePk,
      )
  return updated
}

export interface CounterTarget {
  locator: string
  account: { provider: string; account: string }
  chatId: string
  messageId: string
  counters: CounterState[]
}
export const counterTargets = (
  context: StoreContext,
  execution: QueryExecution,
  options: { now: number; maxAge: number },
): { items: CounterTarget[]; hasMore: boolean } =>
  withQuerySelection(context, execution, (selection, check) => {
    const rows = context.database
      .prepare(
        `WITH selected AS (${selection.sql}) SELECT m.pk,m.native_id AS message,c.native_id AS chat,ac.provider,ac.native_id AS account FROM messages m JOIN chats c ON c.pk=m.chat_pk JOIN accounts ac ON ac.pk=m.account_pk WHERE m.pk IN (SELECT pk FROM selected) AND m.deleted_at IS NULL ORDER BY m.sent_at DESC,m.pk DESC LIMIT ?`,
      )
      .all(...selection.params, execution.limit + 1)
    check()
    return {
      items: rows.slice(0, execution.limit).map((row) => {
        check()
        const account = { provider: String(row.provider), account: String(row.account) },
          chatId = String(row.chat),
          messageId = String(row.message)
        return {
          locator: formatLocator({ ...account, chat: chatId, message: messageId }),
          account,
          chatId,
          messageId,
          counters: counterStates(context, Number(row.pk), options.now, options.maxAge),
        }
      }),
      hasMore: rows.length > execution.limit,
    }
  })
