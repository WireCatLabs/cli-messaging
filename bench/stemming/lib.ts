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
