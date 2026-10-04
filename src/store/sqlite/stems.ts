import { CliError } from "@leemour/cli-core"
import {
  analyzerIdentity,
  createStemmer,
  DEFAULT_STEMMERS,
  parseStemmers,
  SNOWBALL_VERSION,
  type Stemmer,
  type Stemmers,
} from "../../search/stem.js"
import type { CacheDatabase } from "../driver.js"
import { inBatch, indexRow } from "./search-index.js"

const INDEX = "message_stems"
const SETTING = "searchStemmers"

/** Stems a store write leaves for the next fill: an older binary may have left thousands queued. */
export const DRAIN_ON_WRITE = 500

export interface StemsState {
  watermark: number
  filledThrough: number
  /** Messages written or edited since their stems were: queued by triggers, emptied by JS. */
  pending: number
  /** What built the stems; `null` until a fill claims the row. */
  built: string | null
  /** What this binary builds with the store's setting. */
  wanted: string
  /** Every live message is stemmed by `wanted`: stemmed search may run. */
  ready: boolean
  /** Why it is not ready: still filling, or built by other choices and waiting for `store reindex`. */
  cause?: "building" | "stemmer_changed"
  builtAt: string | null
}

export interface StemsFill {
  stemmed: number
  drained: number
}

/** The choices `config set searchStemmers.*` saved; `undefined` while the defaults apply. */
export const savedStemmers = (database: CacheDatabase): Stemmers | undefined => {
  const row = database.prepare("SELECT value FROM store_settings WHERE key = ?").get(SETTING)
  return row ? parseStemmers(JSON.parse(String(row.value))) : undefined
}

/** The store-wide stemmer choices every fill, drain and readiness check uses. */
export const storeStemmers = (database: CacheDatabase): Stemmers => savedStemmers(database) ?? DEFAULT_STEMMERS

export const saveStoreStemmers = (database: CacheDatabase, stemmers: Stemmers, now: number): void => {
  database
    .prepare("INSERT OR REPLACE INTO store_settings (key, value, at) VALUES (?, ?, ?)")
    .run(SETTING, JSON.stringify(parseStemmers(stemmers)), now)
}

/** `undefined` on a file before version 15. */
export const stemsState = (database: CacheDatabase): StemsState | undefined => {
  const row = indexRow(database, INDEX)
  if (!row) return undefined
  const watermark = Number(row.watermark)
  const filledThrough = Number(row.filled_through)
  const pending = Number(database.prepare("SELECT count(*) AS n FROM message_stems_pending").get()?.n)
  const built = row.analyzer === null ? null : String(row.analyzer)
  const wanted = analyzerIdentity(storeStemmers(database))
  const ready = built === wanted && filledThrough >= watermark && pending === 0
  return {
    watermark,
    filledThrough,
    pending,
    built,
    wanted,
    ready,
    ...(ready ? {} : { cause: built !== null && built !== wanted ? "stemmer_changed" : "building" }),
    builtAt: row.built_at === null ? null : new Date(Number(row.built_at)).toISOString(),
  }
}

/**
 * Whether this binary may write stems, decided inside the write transaction: an unbuilt row is claimed
 * with its analyzer, a row built by other choices is left alone — so the index never mixes two stemmers.
 */
const claim = (database: CacheDatabase, identity: string): boolean => {
  const built = indexRow(database, INDEX)?.analyzer
  if (built === undefined) return false
  if (built === null) {
    database.prepare("UPDATE search_index_state SET analyzer = ? WHERE name = ?").run(identity, INDEX)
    return true
  }
  return built === identity
}

const stemWriter = (database: CacheDatabase, stemmer: Stemmer) => {
  const read = database.prepare(
    `SELECT pk, text, 'c' || chat_pk || coalesce(' s' || sender_identity_pk, '') AS scope
       FROM messages WHERE pk > ? AND pk <= ?`,
  )
  const one = database.prepare(
    "SELECT text, 'c' || chat_pk || coalesce(' s' || sender_identity_pk, '') AS scope FROM messages WHERE pk = ?",
  )
  const write = database.prepare("INSERT OR REPLACE INTO message_stems (rowid, stems, scope) VALUES (?, ?, ?)")
  const remove = database.prepare("DELETE FROM message_stems WHERE rowid = ?")
  const dequeue = database.prepare("DELETE FROM message_stems_pending WHERE pk = ?")
  const restem = (pk: number, row: Record<string, unknown> | undefined) => {
    const stems = row ? stemmer.stemTokens(String(row.text)).join(" ") : ""
    if (stems === "") remove.run(pk)
    else write.run(pk, stems, String(row?.scope))
  }
  return {
    range: (from: number, to: number) => {
      const rows = read.all(from, to)
      for (const row of rows) restem(Number(row.pk), row)
      return rows.length
    },
    queued: (pks: number[]) => {
      for (const pk of pks) {
        restem(pk, one.get(pk))
        dequeue.run(pk)
      }
      return pks.length
    },
  }
}

const nextQueued = (database: CacheDatabase, limit: number): number[] =>
  database
    .prepare("SELECT pk FROM message_stems_pending ORDER BY pk LIMIT ?")
    .all(limit)
    .map((row) => Number(row.pk))

/**
 * Stems the messages a store write queued, inside that write's transaction. `stemmerFor` is the store's,
 * so one cache serves every write while the setting stays the same.
 */
export const drainStems = (
  database: CacheDatabase,
  stemmerFor: (stemmers: Stemmers) => Stemmer,
  limit = DRAIN_ON_WRITE,
): number => {
  const pks = nextQueued(database, limit)
  if (pks.length === 0) return 0
  const stemmer = stemmerFor(storeStemmers(database))
  return claim(database, stemmer.identity) ? stemWriter(database, stemmer).queued(pks) : 0
}

/** Keeps one stemmer while the setting stays the same, and starts a fresh cache when it changes. */
export const stemmerCache = (): ((stemmers: Stemmers) => Stemmer) => {
  let stemmer: Stemmer | undefined
  return (stemmers) => {
    if (stemmer?.identity !== analyzerIdentity(stemmers)) stemmer = createStemmer(stemmers)
    return stemmer
  }
}

/**
 * Brings the stems towards "ready" in short write transactions: the messages up to the watermark, then
 * the queue. One stemmer per run, so its cache serves every batch. Never rebuilds: a row built by other
 * choices is left for `store migrate` or `store reindex`.
 */
export const fillStems = (
  database: CacheDatabase,
  {
    batch = 5_000,
    until = () => false,
    onBatch,
    now = Date.now,
  }: { batch?: number; until?: () => boolean; onBatch?: (step: string, done: number) => void; now?: () => number } = {},
): StemsFill => {
  const filled: StemsFill = { stemmed: 0, drained: 0 }
  const before = stemsState(database)
  // Every search asks; when all is built, or the row waits for a rebuild, it must not take the write lock.
  if (!before || before.ready || before.cause === "stemmer_changed") return filled
  const stemmers = storeStemmers(database)
  const identity = analyzerIdentity(stemmers)
  const stemmer = createStemmer(stemmers)
  const writer = stemWriter(database, stemmer)
  const advance = database.prepare("UPDATE search_index_state SET filled_through = ? WHERE name = ?")
  for (;;) {
    const state = stemsState(database)
    if (!state || state.filledThrough >= state.watermark || until()) break
    const to = Math.min(state.filledThrough + batch, state.watermark)
    const done = inBatch(database, () => {
      if (!claim(database, identity)) return undefined
      const count = writer.range(state.filledThrough, to)
      advance.run(to, INDEX)
      return count
    })
    if (done === undefined) return filled
    filled.stemmed += done
    onBatch?.("stemmed", filled.stemmed)
  }
  for (;;) {
    if (until()) break
    const done = inBatch(database, () => {
      const pks = nextQueued(database, batch)
      return pks.length === 0 || !claim(database, identity) ? 0 : writer.queued(pks)
    })
    if (done === 0) break
    filled.drained += done
    onBatch?.("drained", filled.drained)
  }
  const state = stemsState(database)
  if (state && state.filledThrough >= state.watermark && state.builtAt === null && state.built === identity) {
    database.prepare("UPDATE search_index_state SET built_at = ? WHERE name = ?").run(now(), INDEX)
  }
  return filled
}

const snowballOf = (identity: string): number[] =>
  (/^snowball-(\d+)\.(\d+)\.(\d+)/.exec(identity)?.slice(1) ?? []).map(Number)

const newer = (a: number[], b: number[]): boolean => {
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  return false
}

/**
 * Empties the stems and starts them again from the newest message, claimed by the store's setting —
 * for `store reindex`, and for `store migrate` when the stems were built by other choices. A row built
 * by a newer Snowball than this binary has is refused: rebuilding it would downgrade every newer tool.
 */
export const resetStems = (database: CacheDatabase, { force = false }: { force?: boolean } = {}): boolean => {
  const state = stemsState(database)
  if (!state) return false
  if (!force && state.cause !== "stemmer_changed") return false
  if (state.built !== null && newer(snowballOf(state.built), snowballOf(`snowball-${SNOWBALL_VERSION}`))) {
    throw new CliError(
      "validation_error",
      `the stems were built by Snowball ${snowballOf(state.built).join(".")}, newer than this tool's ${SNOWBALL_VERSION} — upgrade this tool`,
      { reason: "stemmer_newer", built: state.built, wanted: state.wanted },
    )
  }
  inBatch(database, () => {
    database.exec(`INSERT INTO ${INDEX} (${INDEX}) VALUES ('delete-all')`)
    database.exec("DELETE FROM message_stems_pending")
    database
      .prepare(
        `UPDATE search_index_state SET watermark = (SELECT coalesce(max(pk), 0) FROM messages),
           filled_through = 0, built_at = NULL, analyzer = ? WHERE name = ?`,
      )
      .run(state.wanted, INDEX)
  })
  return true
}
