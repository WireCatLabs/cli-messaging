import type { CacheDatabase } from "../driver.js"
import { NORMALIZER_VERSION, normalize } from "../normalize.js"

/** Live messages stored before version 6, still without their normalized text. An index lookup. */
export const pendingNormalization = (database: CacheDatabase): number =>
  Number(
    database.prepare("SELECT count(*) AS n FROM messages WHERE normalized_text IS NULL AND deleted_at IS NULL").get()
      ?.n,
  )

/**
 * Fills them in batches by `pk`, one short write transaction each, so other processes wait for one
 * batch at most. Stopping between batches loses nothing: the next run starts from what is left.
 */
export const backfillNormalized = (
  database: CacheDatabase,
  {
    batch = 5_000,
    onBatch,
    until = () => false,
  }: { batch?: number; onBatch?: (filled: number) => void; until?: () => boolean } = {},
): number => {
  const next = database.prepare(
    `SELECT pk, text FROM messages WHERE normalized_text IS NULL AND deleted_at IS NULL AND pk > ? ORDER BY pk LIMIT ?`,
  )
  const fill = database.prepare("UPDATE messages SET normalized_text = ?, normalizer_version = ? WHERE pk = ?")
  let filled = 0
  let after = 0
  for (;;) {
    if (until()) return filled
    database.exec("BEGIN IMMEDIATE")
    let rows: Record<string, unknown>[]
    try {
      rows = next.all(after, batch)
      for (const row of rows) fill.run(normalize(String(row.text)), NORMALIZER_VERSION, Number(row.pk))
      database.exec("COMMIT")
    } catch (error) {
      database.exec("ROLLBACK")
      throw error
    }
    if (rows.length === 0) return filled
    filled += rows.length
    after = Number(rows.at(-1)?.pk)
    onBatch?.(filled)
  }
}
