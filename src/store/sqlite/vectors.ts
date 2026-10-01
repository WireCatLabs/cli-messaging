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
