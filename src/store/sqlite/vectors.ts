import { chunkHash, chunkTextOf, type TextRange } from "../../conversations/chunks.js"
import { type SQL, sql } from "./drizzle/core.js"
import type { StoreContext } from "./open.js"

/** A chunk of the chat's current build: its hash, and the messages its text is cut from. */
export interface ChunkToEmbed {
  hash: string
  lines: { id: string; sender: string | null; text: string }[]
}

const currentChunks = (chatKey: number) => sql`SELECT k.content_hash, k.conversation_pk, k.first_message_pk,
    k.last_message_pk, k.text_start, k.text_end FROM conversation_chunks k JOIN conversations c ON c.pk = k.conversation_pk
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
  const chunks = orm.all<{
    hash: string
    conversation: number
    first: number
    last: number
    start: number | null
    end: number | null
  }>(
    sql`SELECT k.content_hash AS hash, min(k.conversation_pk) AS conversation, k.first_message_pk AS first,
        k.last_message_pk AS last, k.text_start AS start, k.text_end AS end
      FROM (${currentChunks(chatKey)}) k
      WHERE k.content_hash > ${after ?? ""}
        AND NOT EXISTS (SELECT 1 FROM chunk_vectors v WHERE v.model = ${model} AND v.content_hash = k.content_hash)
      GROUP BY k.content_hash ORDER BY k.content_hash LIMIT ${limit}`,
  )
  return chunks.map(({ hash, conversation, first, last, start, end }) => {
    const range = rangeOf(start, end)
    return {
      hash,
      lines: chunkLines(orm, conversation, first, last).flatMap(({ deleted, ...line }) =>
        deleted ? [] : [range === undefined ? line : { ...line, text: line.text.slice(range.start, range.end) }],
      ),
    }
  })
}

const rangeOf = (start: number | null, end: number | null): TextRange | undefined =>
  start === null || end === null ? undefined : { start, end }

/** A chunk's messages as they are now, the deleted ones flagged: what `embed` hashes and a search checks. */
const chunkLines = (orm: StoreContext["orm"], conversation: number, first: number, last: number) =>
  orm
    .all<{ id: string; sender: string | null; text: string; deleted: number }>(
      sql`SELECT m.native_id AS id, m.sender_name AS sender, m.text, m.deleted_at IS NOT NULL AS deleted
        FROM conversation_messages cm
        JOIN messages m ON m.pk = cm.message_pk
        JOIN messages f ON f.pk = ${first} JOIN messages l ON l.pk = ${last}
        WHERE cm.conversation_pk = ${conversation}
          AND (m.sent_at, m.pk) >= (f.sent_at, f.pk) AND (m.sent_at, m.pk) <= (l.sent_at, l.pk)
        ORDER BY m.sent_at, m.pk`,
    )
    .map(({ deleted, ...line }) => ({ ...line, deleted: Boolean(deleted) }))

/**
 * Whether a found chunk still says what its vector encodes. A build never makes a deleted message a member,
 * so any deleted one in range went after the build: the hit goes, whatever text is left (NEED-393, NEED-550).
 */
export const chunkFreshness = (
  { orm }: StoreContext,
  { conversationPk, firstMessagePk, lastMessagePk, hash, range }: NearestChunk,
): "current" | "stale" | "deleted" => {
  const lines = chunkLines(orm, conversationPk, firstMessagePk, lastMessagePk)
  if (lines.some(({ deleted }) => deleted)) return "deleted"
  return chunkHash(chunkTextOf(lines, range)) === hash ? "current" : "stale"
}

/**
 * Drops every vector of a chunk that held this just-deleted message, of every model, unless a current chunk
 * with no deleted message still uses its text — in any chat or account, since vectors are keyed by text alone.
 */
export const purgeVectorHashes = (context: StoreContext, hashes: readonly string[]): void => {
  const { orm } = context
  for (const hash of new Set(hashes)) {
    let offset = 0
    let valid = false
    for (;;) {
      const candidates = orm.all<{
        conversation: number
        first: number
        last: number
        start: number | null
        end: number | null
      }>(sql`SELECT k.conversation_pk AS conversation, k.first_message_pk AS first,
        k.last_message_pk AS last, k.text_start AS start, k.text_end AS end
        FROM conversation_chunks k JOIN conversations c ON c.pk = k.conversation_pk
        JOIN conversation_state s ON s.chat_pk = c.chat_pk AND s.current_build = c.build
        WHERE k.content_hash = ${hash} ORDER BY k.conversation_pk, k.ordinal LIMIT 100 OFFSET ${offset}`)
      valid = candidates.some(({ conversation, first, last, start, end }) => {
        const lines = chunkLines(orm, conversation, first, last)
        return !lines.some(({ deleted }) => deleted) && chunkHash(chunkTextOf(lines, rangeOf(start, end))) === hash
      })
      if (valid || candidates.length < 100) break
      offset += candidates.length
      if (offset >= 1000) {
        valid = true
        break
      }
    }
    if (!valid) orm.run(sql`DELETE FROM chunk_vectors WHERE content_hash = ${hash}`)
  }
}

export const purgeVectorsOf = (context: StoreContext, messagePk: number): void => {
  const hashes = context.orm.all<{ hash: string }>(sql`SELECT DISTINCT k.content_hash AS hash
    FROM conversation_messages cm JOIN messages m ON m.pk = cm.message_pk
    JOIN conversation_chunks k ON k.conversation_pk = cm.conversation_pk
    JOIN messages f ON f.pk = k.first_message_pk JOIN messages l ON l.pk = k.last_message_pk
    WHERE cm.message_pk = ${messagePk}
      AND (m.sent_at, m.pk) >= (f.sent_at, f.pk) AND (m.sent_at, m.pk) <= (l.sent_at, l.pk)`)
  purgeVectorHashes(
    context,
    hashes.map(({ hash }) => hash),
  )
}

/**
 * A conversation's chunks of the current build, and the vectors of `model` that still say what its chunks say:
 * a changed or deleted message leaves its chunk out, so the conversation is described as it is now.
 */
export const conversationVectors = (
  context: StoreContext,
  conversationPk: number,
  model: string,
): { chunks: number; vectors: Float32Array[] } => {
  const rows = context.orm.all<{
    first: number
    last: number
    start: number | null
    end: number | null
    hash: string
    vector: Uint8Array | null
  }>(
    sql`SELECT k.first_message_pk AS first, k.last_message_pk AS last, k.text_start AS start, k.text_end AS end,
        k.content_hash AS hash, v.vector
      FROM conversation_chunks k
      JOIN conversations c ON c.pk = k.conversation_pk
      JOIN conversation_state s ON s.chat_pk = c.chat_pk AND s.current_build = c.build
      LEFT JOIN chunk_vectors v ON v.model = ${model} AND v.content_hash = k.content_hash
      WHERE k.conversation_pk = ${conversationPk} ORDER BY k.ordinal`,
  )
  const vectors = rows.flatMap(({ first, last, start, end, hash, vector }) =>
    vector &&
    chunkFreshness(context, {
      conversationPk,
      firstMessagePk: first,
      lastMessagePk: last,
      ...(rangeOf(start, end) ? { range: rangeOf(start, end) } : {}),
      hash,
      score: 0,
    }) === "current"
      ? [new Float32Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength))]
      : [],
  )
  return { chunks: rows.length, vectors }
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
  /** The stretch of one long message, when the chunk is a piece of it. */
  range?: TextRange
  hash: string
  score: number
}

/** Rows read per step of a search, so a chat of any size is scanned in bounded memory. */
const SCAN_PAGE = 5_000

export const dot = (query: Float32Array, blob: Uint8Array): number => {
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
    exclude,
    conversations,
  }: {
    chatKey?: number
    model: string
    since?: number
    limit: number
    query: Float32Array
    exclude?: number
    conversations?: string[]
  },
): NearestChunk[] => {
  const best = new Map<number, NearestChunk>()
  let after = { conversation: 0, ordinal: -1 }
  for (;;) {
    const rows = orm.all<{
      conversation: number
      ordinal: number
      first: number
      last: number
      start: number | null
      end: number | null
      hash: string
      vector: Uint8Array
    }>(
      // CROSS JOIN keeps the chunks first, so each page walks their key; led by the vectors, SQLite re-read and
      // sorted every one of them per page — 1.3 s against 140 ms at 42k chunks (bench/embeddings/README.md).
      sql`SELECT k.conversation_pk AS conversation, k.ordinal, k.first_message_pk AS first, k.last_message_pk AS last,
          k.text_start AS start, k.text_end AS end, k.content_hash AS hash, v.vector FROM conversation_chunks k
        CROSS JOIN conversations c ON c.pk = k.conversation_pk
        JOIN conversation_state s ON s.chat_pk = c.chat_pk AND s.current_build = c.build
        JOIN chats ch ON ch.pk = c.chat_pk
        JOIN chunk_vectors v ON v.model = ${model} AND v.content_hash = k.content_hash
        WHERE ch.account_pk = ${accountPk}
          ${chatKey === undefined ? sql`` : sql`AND c.chat_pk = ${chatKey}`}
          ${since === undefined ? sql`` : sql`AND c.last_at >= ${since}`}
          ${exclude === undefined ? sql`` : sql`AND c.pk <> ${exclude}`}
          ${conversations === undefined ? sql`` : sql`AND c.pk IN (SELECT value FROM json_each(${JSON.stringify(conversations)}))`}
          AND (k.conversation_pk, k.ordinal) > (${after.conversation}, ${after.ordinal})
        ORDER BY k.conversation_pk, k.ordinal LIMIT ${SCAN_PAGE}`,
    )
    for (const row of rows) {
      const score = dot(query, row.vector)
      const held = best.get(row.conversation)
      if (!held || score > held.score) {
        const range = rangeOf(row.start, row.end)
        best.set(row.conversation, {
          conversationPk: row.conversation,
          firstMessagePk: row.first,
          lastMessagePk: row.last,
          ...(range ? { range } : {}),
          hash: row.hash,
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

/** Chats of the account whose conversations were ever built, or started to be. */
export const builtChats = ({ orm }: StoreContext, accountPk: number): { chatKey: number; id: string }[] =>
  orm.all<{ chatKey: number; id: string }>(
    sql`SELECT ch.pk AS chatKey, ch.native_id AS id FROM conversation_state s JOIN chats ch ON ch.pk = s.chat_pk
      WHERE ch.account_pk = ${accountPk} ORDER BY ch.native_id`,
  )

/** Group chats of the account with stored messages and no build ever started, the newest message first. */
export const unbuiltGroups = ({ orm }: StoreContext, accountPk: number): string[] =>
  orm
    .all<{ id: string }>(
      sql`SELECT ch.native_id AS id FROM chats ch
        WHERE ch.account_pk = ${accountPk} AND ch.kind = 'group'
          AND NOT EXISTS (SELECT 1 FROM conversation_state s WHERE s.chat_pk = ch.pk)
          AND EXISTS (SELECT 1 FROM messages m WHERE m.chat_pk = ch.pk AND m.deleted_at IS NULL)
        ORDER BY (SELECT max(m.sent_at) FROM messages m WHERE m.chat_pk = ch.pk) DESC, ch.native_id`,
    )
    .map(({ id }) => id)

/**
 * What the chat's current build has not seen, and its chunks for `model`. Membership is exact for new and
 * deleted messages; an edit is known only by its revision's time, so one in the build's first millisecond
 * counts as pending. A changed sender name leaves no trace and is not counted.
 */
export const readiness = ({ orm }: StoreContext, chatKey: number, model: string) => {
  const state = orm.get<{ builtAt: number | null; algorithmVersion: number | null; build: number | null }>(
    sql`SELECT built_at AS builtAt, algorithm_version AS algorithmVersion, current_build AS build
      FROM conversation_state WHERE chat_pk = ${chatKey}`,
  )
  if (!state || state.builtAt === null || state.build === null) return undefined
  const { builtAt, build } = state
  const member = (pk: SQL) => sql`EXISTS (SELECT 1 FROM conversation_messages cm
    JOIN conversations c ON c.pk = cm.conversation_pk WHERE cm.message_pk = ${pk} AND c.build = ${build})`
  const editedSince = (pk: SQL) =>
    sql`EXISTS (SELECT 1 FROM message_revisions r WHERE r.message_pk = ${pk} AND r.captured_at >= ${builtAt})`
  const pending = orm.get<{ new: number; edited: number; deleted: number }>(
    sql`SELECT
        sum(m.deleted_at IS NULL AND NOT ${member(sql`m.pk`)}) AS new,
        sum(m.deleted_at IS NULL AND ${editedSince(sql`m.pk`)} AND ${member(sql`m.pk`)}) AS edited,
        sum(m.deleted_at IS NOT NULL AND ${member(sql`m.pk`)}) AS deleted
      FROM messages m WHERE m.chat_pk = ${chatKey}`,
  )
  const vectors = orm.get<{ chunks: number; embedded: number; current: number; stale: number }>(
    sql`WITH changed AS (SELECT m.pk, m.sent_at, cm.conversation_pk FROM messages m
          JOIN conversation_messages cm ON cm.message_pk = m.pk
          JOIN conversations c ON c.pk = cm.conversation_pk AND c.build = ${build}
          WHERE m.chat_pk = ${chatKey} AND (m.deleted_at IS NOT NULL OR ${editedSince(sql`m.pk`)})),
        stale AS (SELECT DISTINCT k.content_hash AS hash FROM changed g
          JOIN conversation_chunks k ON k.conversation_pk = g.conversation_pk
          JOIN messages f ON f.pk = k.first_message_pk JOIN messages l ON l.pk = k.last_message_pk
          WHERE (g.sent_at, g.pk) >= (f.sent_at, f.pk) AND (g.sent_at, g.pk) <= (l.sent_at, l.pk)),
        hashes AS (SELECT DISTINCT h.content_hash AS hash,
            EXISTS (SELECT 1 FROM chunk_vectors v WHERE v.model = ${model} AND v.content_hash = h.content_hash) AS vector,
            h.content_hash IN (SELECT hash FROM stale) AS stale
          FROM (${currentChunks(chatKey)}) h)
      SELECT count(*) AS chunks, sum(vector) AS embedded, sum(vector AND NOT stale) AS current, sum(stale) AS stale
      FROM hashes`,
  )
  const chunks = Number(vectors?.chunks ?? 0)
  const current = Number(vectors?.current ?? 0)
  const stale = Number(vectors?.stale ?? 0)
  return {
    builtAt,
    algorithmVersion: state.algorithmVersion,
    pending: {
      new: Number(pending?.new ?? 0),
      edited: Number(pending?.edited ?? 0),
      deleted: Number(pending?.deleted ?? 0),
    },
    vectors: { chunks, embedded: Number(vectors?.embedded ?? 0), current, stale, missing: chunks - current - stale },
  }
}
