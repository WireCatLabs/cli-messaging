import { CHUNK_CHARS, chunkHash, splitText } from "../../conversations/chunks.js"
import { analyzerIdentity, DEFAULT_STEMMERS, type Stemmer, type Stemmers } from "../../search/stem.js"
import type { CacheDatabase } from "../driver.js"
import { normalize } from "../normalize.js"
import { inBatch, indexRow } from "./search-index.js"
import { savedStemmers } from "./stems.js"

const INDEX = "note_index"

export interface NoteIndexState {
  /** Notes written since they were indexed. */
  pending: number
  /** The stemmer choices the stems were built by; `null` until the first drain. */
  built: string | null
  wanted: string | null
  /** Every live note is in the words, stems and chunks: a notes search sees all of them. */
  ready: boolean
}

/** What a note is indexed as: its title, then its text. Chunk offsets point into this. */
export const noteIndexText = (title: string | null, text: string): string => (title ? `${title}\n\n${text}` : text)

/** `undefined` on a file before version 26. */
export const noteIndexState = (database: CacheDatabase): NoteIndexState | undefined => {
  const row = indexRow(database, INDEX)
  if (!row) return undefined
  const pending = Number(database.prepare("SELECT count(*) AS n FROM note_index_pending").get()?.n)
  const saved = savedStemmers(database)
  const wanted = saved === null ? null : analyzerIdentity(saved ?? DEFAULT_STEMMERS)
  const built = row.analyzer === null ? null : String(row.analyzer)
  return { pending, built, wanted, ready: pending === 0 && wanted !== null && (built === wanted || built === null) }
}

const writer = (database: CacheDatabase, stemmer: Stemmer) => {
  const read = database.prepare("SELECT title, text, source, deleted_at FROM notes WHERE pk = ?")
  const oldHashes = database.prepare("SELECT content_hash AS hash FROM note_chunks WHERE note_pk = ?")
  const statements = {
    dropWords: database.prepare("DELETE FROM note_words WHERE rowid = ?"),
    dropStems: database.prepare("DELETE FROM note_stems WHERE rowid = ?"),
    dropChunks: database.prepare("DELETE FROM note_chunks WHERE note_pk = ?"),
    words: database.prepare("INSERT INTO note_words (rowid, normalized_text, scope) VALUES (?, ?, ?)"),
    stems: database.prepare("INSERT INTO note_stems (rowid, stems, scope) VALUES (?, ?, ?)"),
    chunk: database.prepare(
      "INSERT INTO note_chunks (note_pk, seq, text_start, text_end, content_hash) VALUES (?, ?, ?, ?, ?)",
    ),
    purge: database.prepare(
      `DELETE FROM chunk_vectors WHERE content_hash = ?
         AND NOT EXISTS (SELECT 1 FROM note_chunks WHERE content_hash = ?)
         AND NOT EXISTS (SELECT 1 FROM conversation_chunks WHERE content_hash = ?)`,
    ),
    dequeue: database.prepare("DELETE FROM note_index_pending WHERE pk = ?"),
  }
  return (pk: number) => {
    const row = read.get(pk)
    const before = oldHashes.all(pk).map((hash) => String(hash.hash))
    statements.dropWords.run(pk)
    statements.dropStems.run(pk)
    statements.dropChunks.run(pk)
    const live = row !== undefined && row.deleted_at === null
    const text = live ? noteIndexText(row.title === null ? null : String(row.title), String(row.text)) : ""
    const scope = live ? `s${String(row.source)}` : ""
    const words = normalize(text)
    if (words !== "") statements.words.run(pk, words, scope)
    const stems = text ? stemmer.indexText(text) : ""
    if (stems !== "") statements.stems.run(pk, stems, scope)
    const after = new Set<string>()
    if (text.trim()) {
      splitText(text, CHUNK_CHARS).forEach(({ start, end }, seq) => {
        const hash = chunkHash(text.slice(start, end))
        after.add(hash)
        statements.chunk.run(pk, seq, start, end, hash)
      })
    }
    for (const hash of before) if (!after.has(hash)) statements.purge.run(hash, hash, hash)
    statements.dequeue.run(pk)
  }
}

/**
 * Indexes the notes written since the last drain, in short write transactions. Notes are few, so a change
 * of stemmer choices simply queues every note again instead of waiting for `store reindex` as messages do.
 */
export const drainNoteIndex = (
  database: CacheDatabase,
  stemmerFor: (stemmers: Stemmers) => Stemmer,
  { batch = 200, until = () => false }: { batch?: number; until?: () => boolean } = {},
): number => {
  const state = noteIndexState(database)
  if (!state || state.wanted === null) return 0
  const saved = savedStemmers(database)
  const stemmer = stemmerFor(saved ?? DEFAULT_STEMMERS)
  if (state.built !== stemmer.identity) {
    inBatch(database, () => {
      if (state.built !== null) database.exec("INSERT OR IGNORE INTO note_index_pending (pk) SELECT pk FROM notes")
      database.prepare("UPDATE search_index_state SET analyzer = ? WHERE name = ?").run(stemmer.identity, INDEX)
    })
  }
  if (state.pending === 0 && state.built === stemmer.identity) return 0
  const next = database.prepare("SELECT pk FROM note_index_pending ORDER BY pk LIMIT ?")
  const index = writer(database, stemmer)
  let done = 0
  for (;;) {
    if (until()) break
    const count = inBatch(database, () => {
      const pks = next.all(batch).map((row) => Number(row.pk))
      for (const pk of pks) index(pk)
      return pks.length
    })
    if (count === 0) break
    done += count
  }
  return done
}

/** Queues every note again — for `store reindex`. */
export const resetNoteIndex = (database: CacheDatabase): boolean => {
  if (!indexRow(database, INDEX)) return false
  inBatch(database, () => database.exec("INSERT OR IGNORE INTO note_index_pending (pk) SELECT pk FROM notes"))
  return true
}
