import { appendFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"

export const BENCH_DIR = dirname(fileURLToPath(import.meta.url))
export const DATA = join(BENCH_DIR, "data")
export const RESULTS = join(BENCH_DIR, "results.md")

const dist = join(BENCH_DIR, "../../dist")
export const { normalize } = (await import(join(dist, "store/normalize.js"))) as { normalize: (s: string) => string }
export const { correctWords, editDistance, maxEdits } = (await import(join(dist, "search/correct.js"))) as {
  correctWords: (
    vocabulary: {
      knownTerms(t: string[]): Promise<Set<string>>
      termCandidates(p: string[], l: { shortest: number; longest: number }): Promise<{ term: string; docs: number }[]>
    },
    words: string[],
  ) => Promise<Map<string, string[]>>
  editDistance: (a: string, b: string, max: number) => number
  maxEdits: (w: string) => number
}
export const { trigrams } = (await import(join(dist, "search/trigrams.js"))) as { trigrams: (t: string) => string[] }
export const words = (await import(join(dist, "store/sqlite/words.js"))) as {
  knownTerms: (c: { database: DatabaseSync }, terms: string[]) => Set<string>
  termCandidates: (
    c: { database: DatabaseSync },
    pieces: string[],
    l: { shortest: number; longest: number },
  ) => { term: string; docs: number }[]
}

type Stemmer = { stemWord: (w: string) => string }
const load = async (lang: string): Promise<Stemmer> => {
  const { default: Cls } = await import(join(DATA, "snowball/js", `${lang}-stemmer.js`))
  return new Cls()
}
export const official = { ru: await load("russian"), es: await load("spanish"), en: await load("english") }

export type LatinStemmer = "es" | "en"
const CYRILLIC = /\p{Script=Cyrillic}/u
const LATIN = /\p{Script=Latin}/u

/** The language is chosen by the script of the word: Cyrillic → Russian, Latin → Spanish (or English, as a reference). */
export const stemOf = (word: string, latin: LatinStemmer = "es"): string => {
  if (CYRILLIC.test(word)) return official.ru.stemWord(word)
  if (LATIN.test(word)) return official[latin].stemWord(word)
  return word
}

/** What unicode61 keeps as a token (L*, N*, Co); marks too, so an unfolded word with a combining accent stays whole. */
const TOKEN = /[\p{L}\p{N}\p{Co}\p{M}]+/gu
export const tokenize = (text: string): string[] => text.match(TOKEN) ?? []

export type Order = "stem-then-fold" | "fold-then-stem"
export const stemTokens = (text: string, order: Order = "stem-then-fold", latin: LatinStemmer = "es"): string[] =>
  order === "stem-then-fold"
    ? tokenize(text.normalize("NFC").toLowerCase()).map((t) => normalize(stemOf(t, latin)))
    : tokenize(normalize(text)).map((t) => stemOf(t, latin))

export const stemQuery = (word: string, order: Order = "stem-then-fold", latin: LatinStemmer = "es"): string =>
  stemTokens(word, order, latin)[0] ?? ""

export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const quoted = (text: string) => `"${text.replaceAll('"', '""')}"`
export const pctl = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] as number
}
export const fmt = (n: number, digits = 3) => n.toFixed(digits)
export const out = (line = "") => {
  process.stdout.write(`${line}\n`)
  appendFileSync(RESULTS, `${line}\n`)
}

type Database = DatabaseSync
type Migration = { version: number }
/** The product's store code, from dist: what the gate measures instead of the bench's own DDL. */
export const product = {
  ...((await import(join(dist, "store/open.js"))) as { openCache: (path: string) => Promise<Database> }),
  ...((await import(join(dist, "store/migrations.js"))) as {
    MIGRATIONS: Migration[]
    migrate: (db: Database, options?: { migrations?: Migration[] }) => void
  }),
  ...((await import(join(dist, "store/sqlite/stems.js"))) as {
    fillStems: (db: Database, options?: { batch?: number }) => { stemmed: number; drained: number }
    stemsState: (db: Database) => { ready: boolean; built: string | null; pending: number } | undefined
  }),
  ...((await import(join(dist, "search/stem.js"))) as {
    createStemmer: () => { identity: string; stemTokens: (text: string) => string[] }
  }),
}

export type StoredMessage = { id: number; text: string; normalized: string; chat?: number; sender?: number; at?: number }

/**
 * A store file as an existing archive reaches this build: messages written at version 14, then migrated, so
 * migration 15 finds them below its watermark and `fillStems` stems them in batches.
 */
export const archiveStore = async (path: string, messages: AsyncIterable<StoredMessage> | Iterable<StoredMessage>) => {
  const db = await product.openCache(path)
  product.migrate(db, { migrations: product.MIGRATIONS.filter(({ version }) => version <= 14) })
  db.exec("INSERT INTO accounts (pk, provider, native_id, created_at) VALUES (1, 'telegram', '1', 0)")
  const chats = new Set<number>()
  const chat = db.prepare("INSERT INTO chats (pk, account_pk, native_id, kind, updated_at) VALUES (?, 1, ?, 'group', 0)")
  const insert = db.prepare(
    `INSERT INTO messages (pk, chat_pk, account_pk, native_id, sent_at, text, normalized_text, normalizer_version,
       ingested_at, ingested_via) VALUES (?, ?, 1, ?, ?, ?, ?, 1, 0, 'history')`,
  )
  let n = 0
  db.exec("BEGIN")
  for await (const m of messages) {
    const chatPk = m.chat ?? 1
    if (!chats.has(chatPk)) {
      chat.run(chatPk, String(chatPk))
      chats.add(chatPk)
    }
    insert.run(m.id, chatPk, String(m.id), m.at ?? m.id, m.text, m.normalized)
    if (++n % 50_000 === 0) db.exec("COMMIT; BEGIN")
  }
  db.exec("COMMIT")
  product.migrate(db)
  return db
}
