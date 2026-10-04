import { CliError } from "@leemour/cli-core"
import { normalize } from "../store/normalize.js"
import EnglishStemmer from "./snowball/english-stemmer.js"
import RussianStemmer from "./snowball/russian-stemmer.js"
import SpanishStemmer from "./snowball/spanish-stemmer.js"

/** The version of the vendored files in `./snowball/`; `bin/snowball-update` regenerates them. */
export const SNOWBALL_VERSION = "3.1.1"

export const CYRILLIC_STEMMERS = ["russian", "none"] as const
export const LATIN_STEMMERS = ["spanish", "english", "none"] as const
export type CyrillicStemmer = (typeof CYRILLIC_STEMMERS)[number]
export type LatinStemmer = (typeof LATIN_STEMMERS)[number]
export type Stemmers = { cyrillic: CyrillicStemmer; latin: LatinStemmer }

export const DEFAULT_STEMMERS: Stemmers = { cyrillic: "russian", latin: "spanish" }

/** Clear-all rather than LRU: the 1M benchmark corpus holds 523k distinct words, and a Map stays cheap below this. */
export const STEM_CACHE_LIMIT = 200_000

/** Recorded beside an index built with these choices; a different value means the index must be rebuilt. */
export const analyzerIdentity = (stemmers: Stemmers): string =>
  `snowball-${SNOWBALL_VERSION} cyrillic=${stemmers.cyrillic} latin=${stemmers.latin}`

/** Checks choices that come from outside the type system — the store, a config value, an MCP argument. */
export const parseStemmers = (value: unknown): Stemmers => {
  const record = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>
  const pick = <T extends string>(script: string, allowed: readonly T[], fallback: T): T => {
    const choice = record[script] ?? fallback
    if (allowed.includes(choice as T)) return choice as T
    throw new CliError(
      "validation_error",
      `${script} words cannot be stemmed with ${JSON.stringify(choice)} — choose ${allowed.join(", ")}`,
      { reason: "invalid_stemmer", script, allowed: [...allowed] },
    )
  }
  return {
    cyrillic: pick("cyrillic", CYRILLIC_STEMMERS, DEFAULT_STEMMERS.cyrillic),
    latin: pick("latin", LATIN_STEMMERS, DEFAULT_STEMMERS.latin),
  }
}

/** What FTS5 `unicode61` keeps inside a token: letters, digits, private use, and combining marks. */
const TOKEN = /[\p{L}\p{N}\p{Co}\p{M}]+/gu
const MARKS = /\p{M}+/gu
const CYRILLIC = /^\p{Script=Cyrillic}+$/u
const LATIN = /^\p{Script=Latin}+$/u

const snowball = {
  russian: () => new RussianStemmer(),
  spanish: () => new SpanishStemmer(),
  english: () => new EnglishStemmer(),
  none: () => null,
}

export type Stemmer = {
  readonly stemmers: Stemmers
  readonly identity: string
  /** The indexed form of one token: stemmed by the script of its letters, then folded with `normalize()`. */
  stemToken(token: string): string
  /** `stemToken` over every word of a text, split as `unicode61` splits it; tokens that fold to nothing are dropped. */
  stemTokens(text: string): string[]
}

/**
 * One stemmer per fill run or write drain: it owns its cache, so a cache never outlives the choices it was
 * built with. A token is stemmed only when all its letters are of one script and it has no digit: mixed scripts
 * (`Москвa` with a Latin `a`) are usually homoglyph spoofing or code, and `covid19` is a name, not a word form.
 * Ukrainian and other Cyrillic languages go through the Russian stemmer — there is no language detection.
 */
export const createStemmer = (
  stemmers: Stemmers = DEFAULT_STEMMERS,
  { cacheLimit = STEM_CACHE_LIMIT }: { cacheLimit?: number } = {},
): Stemmer => {
  const valid = parseStemmers(stemmers)
  const cyrillic = snowball[valid.cyrillic]()
  const latin = snowball[valid.latin]()
  const cache = new Map<string, string>()

  const compute = (token: string): string => {
    // Stress marks survive NFC (кварти́ру) and would hide the suffix from Snowball; ё and й compose and stay.
    const word = token.normalize("NFC").toLowerCase().replace(MARKS, "")
    const engine = CYRILLIC.test(word) ? cyrillic : LATIN.test(word) ? latin : null
    const stem = engine?.stemWord(word) || word
    return normalize(stem)
  }

  const stemToken = (token: string): string => {
    const cached = cache.get(token)
    if (cached !== undefined) return cached
    const stem = compute(token)
    if (cache.size >= cacheLimit) cache.clear()
    if (cacheLimit > 0) cache.set(token, stem)
    return stem
  }

  return {
    stemmers: valid,
    identity: analyzerIdentity(valid),
    stemToken,
    stemTokens: (text) => (text.normalize("NFC").toLowerCase().match(TOKEN) ?? []).map(stemToken).filter(Boolean),
  }
}
