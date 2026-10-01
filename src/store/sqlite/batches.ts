import { createHash } from "node:crypto"
import type { Id } from "../../domain/models.js"
import type { BatchMessage, LinkBatch } from "../store.js"
import { type SQL, sql } from "./drizzle/core.js"
import type { StoreContext } from "./open.js"
import { toIso } from "./values.js"

/** How many messages before the first one to answer the agent sees: 97% of reply parents sit within 50. */
export const BATCH_CONTEXT = 50

/**
 * Phase 4 plan A2: a live message the agent is asked about — no reply the messenger itself records to a
 * message held here, and no current agent answer. A stale answer makes it need the agent again.
 */
const needsAgent = (m: SQL) => sql`(
  NOT EXISTS (SELECT 1 FROM messages p WHERE p.chat_pk = ${m}.chat_pk AND p.native_id = ${m}.reply_to_native_id
    AND p.deleted_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM message_links l WHERE l.message_pk = ${m}.pk AND l.source = 'agent'
    AND l.stale_at IS NULL))`

interface Row {
  pk: number
  native_id: string
  sent_at: number
  text: string
  sender_id: string | null
  sender_name: string | null
  reply_to_native_id: string | null
  thread_native_id: string | null
  mentions: string | null
  needs: number
}

const COLUMNS = sql`m.pk, m.native_id, m.sent_at, m.text, coalesce(m.sender_chat_native_id, i.native_id) AS sender_id,
  m.sender_name, m.reply_to_native_id, m.thread_native_id, m.mentions, ${needsAgent(sql`m`)} AS needs`
const FROM = sql`messages m LEFT JOIN identities i ON i.pk = m.sender_identity_pk`

/** `b1.<chat>.<first>.<last>.<hash>`: the window's core, so an answer can be checked against it (A3). */
export const batchId = (chatKey: number, core: number[]): string =>
  `b1.${chatKey}.${core[0]}.${core.at(-1)}.${createHash("sha256").update(core.join(",")).digest("hex").slice(0, 12)}`

/** How much is left to answer, for the agent to tell the user before it starts (A7). */
export const batchStatus = ({ orm }: StoreContext, chatKey: number) => {
  const row = orm.get<{ messages: number; characters: number | null }>(
    sql`SELECT count(*) AS messages, sum(length(m.text)) AS characters FROM messages m
      WHERE m.chat_pk = ${chatKey} AND m.deleted_at IS NULL AND ${needsAgent(sql`m`)}`,
  )
  return { messages: Number(row?.messages ?? 0), characters: Number(row?.characters ?? 0) }
}

/**
 * The earliest window that holds a message needing the agent (A1–A2): from that message, the next
 * `size` live messages — those needing the agent are the core, the rest context — and the `BATCH_CONTEXT`
 * messages before it. `undefined` when nothing is left to answer.
 */
export const nextBatch = (
  context: StoreContext,
  chatKey: number,
  chatId: Id,
  size: number,
): Omit<LinkBatch, "remaining"> | undefined => {
  const { orm } = context
  const first = orm.get<{ pk: number; sent_at: number }>(
    sql`SELECT m.pk, m.sent_at FROM messages m WHERE m.chat_pk = ${chatKey} AND m.deleted_at IS NULL
      AND ${needsAgent(sql`m`)} ORDER BY m.sent_at, m.pk LIMIT 1`,
  )
  if (!first) return undefined
  const live = sql`m.chat_pk = ${chatKey} AND m.deleted_at IS NULL`
  const span = orm.all<Row>(
    sql`SELECT ${COLUMNS} FROM ${FROM} WHERE ${live} AND (m.sent_at, m.pk) >= (${first.sent_at}, ${first.pk})
      ORDER BY m.sent_at, m.pk LIMIT ${size}`,
  )
  const before = orm
    .all<Row>(
      sql`SELECT ${COLUMNS} FROM ${FROM} WHERE ${live} AND (m.sent_at, m.pk) < (${first.sent_at}, ${first.pk})
        ORDER BY m.sent_at DESC, m.pk DESC LIMIT ${BATCH_CONTEXT}`,
    )
    .reverse()
  const core = span.filter((row) => Number(row.needs) === 1)
  const candidates = candidatesOf(
    context,
    core.map(({ pk }) => pk),
  )
  return {
    batch: batchId(
      chatKey,
      core.map(({ pk }) => pk),
    ),
    chat: chatId,
    messages: [...before, ...span].map((row) => toBatchMessage(row, candidates.get(row.pk))),
  }
}

/** The current build's messenger and rule links for the core: the rules' guesses, for the agent to weigh. */
const candidatesOf = ({ orm }: StoreContext, pks: number[]) => {
  const found = new Map<number, BatchMessage["candidates"]>()
  if (pks.length === 0) return found
  const rows = orm.all<{ message_pk: number; parent: string | null; source: string; kind: string; confidence: number }>(
    sql`SELECT l.message_pk, p.native_id AS parent, l.source, l.kind, l.confidence
      FROM message_links l LEFT JOIN messages p ON p.pk = l.parent_pk
      WHERE l.message_pk IN (${sql.join(
        pks.map((pk) => sql`${pk}`),
        sql`, `,
      )}) AND l.source IN ('provider', 'rule')
        AND l.build = (SELECT s.current_build FROM conversation_state s WHERE s.chat_pk = l.chat_pk)
      ORDER BY l.message_pk, l.confidence DESC`,
  )
  for (const row of rows) {
    found.set(row.message_pk, [
      ...(found.get(row.message_pk) ?? []),
      { parent: row.parent, source: row.source, kind: row.kind, confidence: row.confidence },
    ])
  }
  return found
}

const toBatchMessage = (row: Row, candidates: BatchMessage["candidates"] | undefined): BatchMessage => ({
  id: row.native_id,
  at: toIso(row.sent_at) as string,
  sender: { id: row.sender_id, name: row.sender_name },
  text: row.text,
  ...(row.reply_to_native_id === null ? {} : { replyTo: row.reply_to_native_id }),
  ...(row.thread_native_id === null ? {} : { thread: row.thread_native_id }),
  ...(row.mentions === null ? {} : { mentions: JSON.parse(row.mentions) as Id[] }),
  answer: Number(row.needs) === 1,
  ...(Number(row.needs) === 1 ? { candidates: candidates ?? [] } : {}),
})
