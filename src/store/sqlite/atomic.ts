import type { CacheDatabase } from "../driver.js"

let depth = 0

/** A savepoint, so a write that is already inside the store's transaction nests instead of failing. */
export const atomic = <T>(database: CacheDatabase, body: () => T): T => {
  const name = `k${++depth}`
  database.exec(`SAVEPOINT ${name}`)
  try {
    const result = body()
    database.exec(`RELEASE ${name}`)
    return result
  } catch (error) {
    database.exec(`ROLLBACK TO ${name}`)
    database.exec(`RELEASE ${name}`)
    throw error
  } finally {
    depth -= 1
  }
}

/** The id an `INSERT … RETURNING id` gave back. */
export const insertedId = (row: Record<string, unknown> | undefined): number => Number(row?.id)
