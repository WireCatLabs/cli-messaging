import { sql } from "./drizzle/core.js"
import type { StoreContext } from "./open.js"

/** A chunk of the chat's current build: its hash, and the messages its text is cut from. */
export interface ChunkToEmbed {
  hash: string
  lines: { id: string; sender: string | null; text: string }[]
}

const currentChunks = (chatKey: number) => sql`SELECT k.content_hash, k.conversation_pk, k.first_message_pk,
    k.last_message_pk FROM conversation_chunks k JOIN conversations c ON c.pk = k.conversation_pk
  WHERE c.chat_pk = ${chatKey}
    AND c.build = (SELECT s.current_build FROM conversation_state s WHERE s.chat_pk = ${chatKey})`

/**
 * Chunks of the current build with no vector of `model`, ordered by hash from `after`, each with the
 * messages its text is cut from — the text itself is never stored, so it is read again here.
 */
export const chunksToEmbed = (
  { orm }: StoreContext,
  chatKey: number,
  model: string,
  { after, limit }: { after?: string; limit: number },
): ChunkToEmbed[] => {
  const chunks = orm.all<{ hash: string; conversation: number; first: number; last: number }>(
    sql`SELECT k.content_hash AS hash, min(k.conversation_pk) AS conversation, k.first_message_pk AS first,
        k.last_message_pk AS last
      FROM (${currentChunks(chatKey)}) k
      WHERE k.content_hash > ${after ?? ""}
        AND NOT EXISTS (SELECT 1 FROM chunk_vectors v WHERE v.model = ${model} AND v.content_hash = k.content_hash)
      GROUP BY k.content_hash ORDER BY k.content_hash LIMIT ${limit}`,
  )
  return chunks.map(({ hash, conversation, first, last }) => ({
    hash,
    lines: orm.all<{ id: string; sender: string | null; text: string }>(
      sql`SELECT m.native_id AS id, m.sender_name AS sender, m.text FROM conversation_messages cm
        JOIN messages m ON m.pk = cm.message_pk
        JOIN messages f ON f.pk = ${first} JOIN messages l ON l.pk = ${last}
        WHERE cm.conversation_pk = ${conversation} AND m.deleted_at IS NULL
          AND (m.sent_at, m.pk) >= (f.sent_at, f.pk) AND (m.sent_at, m.pk) <= (l.sent_at, l.pk)
        ORDER BY m.sent_at, m.pk`,
    ),
  }))
}

/** A vector already there for the same model and text is kept: the same text gives the same vector. */
export const saveVectors = (
  { orm, now }: StoreContext,
  model: string,
  dims: number,
  vectors: { hash: string; vector: Float32Array }[],
): void => {
  const at = now()
  for (const { hash, vector } of vectors) {
    orm.run(
      sql`INSERT INTO chunk_vectors (model, content_hash, dims, vector, created_at)
        VALUES (${model}, ${hash}, ${dims}, ${Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)}, ${at})
        ON CONFLICT DO NOTHING`,
    )
  }
}

/** The current build's distinct chunk texts, and how many of them have a vector of `model`. */
export const vectorStatus = ({ orm }: StoreContext, chatKey: number, model: string) => {
  const row = orm.get<{ chunks: number; embedded: number }>(
    sql`SELECT count(*) AS chunks, sum(EXISTS (SELECT 1 FROM chunk_vectors v
        WHERE v.model = ${model} AND v.content_hash = k.content_hash)) AS embedded
      FROM (SELECT DISTINCT content_hash FROM (${currentChunks(chatKey)})) k`,
  )
  return { chunks: Number(row?.chunks ?? 0), embedded: Number(row?.embedded ?? 0) }
}

/**
 * Drops the vectors of the chat's chunks, or only one model's — but not one another chat's chunk still
 * points at: the same text in two chats has one vector. Messages are never touched.
 */
export const clearVectors = ({ orm }: StoreContext, chatKey: number, model: string | undefined): number =>
  orm.all<{ n: number }>(
    sql`DELETE FROM chunk_vectors
      WHERE ${model === undefined ? sql`1` : sql`model = ${model}`}
        AND content_hash IN (SELECT k.content_hash FROM conversation_chunks k
          JOIN conversations c ON c.pk = k.conversation_pk WHERE c.chat_pk = ${chatKey})
        AND content_hash NOT IN (SELECT k.content_hash FROM conversation_chunks k
          JOIN conversations c ON c.pk = k.conversation_pk WHERE c.chat_pk <> ${chatKey})
      RETURNING 1 AS n`,
  ).length

export interface NearestChunk {
  conversationPk: number
  firstMessagePk: number
  lastMessagePk: number
  score: number
}

/** Rows read per step of a search, so a chat of any size is scanned in bounded memory. */
const SCAN_PAGE = 5_000

const dot = (query: Float32Array, blob: Uint8Array): number => {
  const vector = new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength))
  let sum = 0
  for (let index = 0; index < query.length; index++) sum += (query[index] as number) * (vector[index] as number)
  return sum
}

/**
 * The conversations of the current builds in scope nearest to `query`, best first: each scored by its
 * best chunk. Vectors are unit length, so the dot product is the cosine (phase 5 E3).
 */
export const nearestChunks = (
  { orm }: StoreContext,
  accountPk: number,
  {
    chatKey,
    model,
    since,
    limit,
    query,
  }: { chatKey?: number; model: string; since?: number; limit: number; query: Float32Array },
): NearestChunk[] => {
  const best = new Map<number, NearestChunk>()
  let after = { conversation: 0, ordinal: -1 }
  for (;;) {
    const rows = orm.all<{ conversation: number; ordinal: number; first: number; last: number; vector: Uint8Array }>(
      // CROSS JOIN keeps the chunks first, so each page walks their key; led by the vectors, SQLite re-read and
      // sorted every one of them per page — 1.3 s against 140 ms at 42k chunks (bench/embeddings/README.md).
      sql`SELECT k.conversation_pk AS conversation, k.ordinal, k.first_message_pk AS first, k.last_message_pk AS last,
          v.vector FROM conversation_chunks k
        CROSS JOIN conversations c ON c.pk = k.conversation_pk
        JOIN conversation_state s ON s.chat_pk = c.chat_pk AND s.current_build = c.build
        JOIN chats ch ON ch.pk = c.chat_pk
        JOIN chunk_vectors v ON v.model = ${model} AND v.content_hash = k.content_hash
        WHERE ch.account_pk = ${accountPk}
          ${chatKey === undefined ? sql`` : sql`AND c.chat_pk = ${chatKey}`}
          ${since === undefined ? sql`` : sql`AND c.last_at >= ${since}`}
          AND (k.conversation_pk, k.ordinal) > (${after.conversation}, ${after.ordinal})
        ORDER BY k.conversation_pk, k.ordinal LIMIT ${SCAN_PAGE}`,
    )
    for (const row of rows) {
      const score = dot(query, row.vector)
      const held = best.get(row.conversation)
      if (!held || score > held.score) {
        best.set(row.conversation, {
          conversationPk: row.conversation,
          firstMessagePk: row.first,
          lastMessagePk: row.last,
          score,
        })
      }
    }
    const last = rows.at(-1)
    if (!last || rows.length < SCAN_PAGE) break
    after = { conversation: last.conversation, ordinal: last.ordinal }
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit)
}

const hasVectorOf = (models: ReturnType<typeof sql>) => sql`EXISTS (SELECT 1 FROM conversation_chunks k
    JOIN conversations c ON c.pk = k.conversation_pk
    JOIN conversation_state s ON s.chat_pk = c.chat_pk AND s.current_build = c.build
    JOIN chunk_vectors v ON v.model ${models} AND v.content_hash = k.content_hash
    WHERE c.chat_pk = ch.pk)`

/** Chats in scope whose current build has vectors of another model and none of `model`: a search with it skips them. */
export const embeddedOnlyElsewhere = (
  { orm }: StoreContext,
  accountPk: number,
  { chatKey, model }: { chatKey?: number; model: string },
): string[] => {
  const others = orm
    .all<{ model: string }>(sql`SELECT DISTINCT model FROM chunk_vectors WHERE model <> ${model}`)
    .map((row) => sql`${row.model}`)
  if (others.length === 0) return []
  return orm
    .all<{ id: string }>(
      sql`SELECT ch.native_id AS id FROM chats ch
        WHERE ch.account_pk = ${accountPk} ${chatKey === undefined ? sql`` : sql`AND ch.pk = ${chatKey}`}
          AND ${hasVectorOf(sql`IN (${sql.join(others, sql`, `)})`)}
          AND NOT ${hasVectorOf(sql`= ${model}`)}
        ORDER BY ch.native_id`,
    )
    .map(({ id }) => id)
}

/** The messenger's ids of these messages, by pk. */
export const messageIds = ({ orm }: StoreContext, pks: number[]): Map<number, string> =>
  new Map(
    pks.length === 0
      ? []
      : orm
          .all<{ pk: number; id: string }>(
            sql`SELECT pk, native_id AS id FROM messages WHERE pk IN (${sql.join(
              pks.map((pk) => sql`${pk}`),
              sql`, `,
            )})`,
          )
          .map(({ pk, id }) => [pk, id]),
  )
