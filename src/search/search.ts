import type { Page } from "../domain/models.js"
import type { MessageStore, ScoredHit, SearchScope, WordQuery } from "../store/store.js"
import { correctWords } from "./correct.js"
import type { Term } from "./query.js"

/** Which step found a hit (plan S4). `filters` answers a search with no word. */
export type Match = "words" | "beginnings" | "corrected" | "anyWord" | "substring" | "filters"

export type SearchHit = ScoredHit & { match: Match }

export interface SearchAnswer {
  items: SearchHit[]
  hasMore: boolean
  corrections: { from: string; to: string[] }[]
  /** `false` while the word index is not built: the answer then came from the substring index alone. */
  wordsReady: boolean
}

export type SearchSteps = Pick<
  MessageStore,
  "searchIndexState" | "matchWords" | "matchSubstring" | "matchFilters" | "knownTerms" | "termCandidates"
>

const tagged = (page: Page<ScoredHit>, match: Match) => page.items.map((hit) => ({ ...hit, match }))

/** Step 1 topped up by step 2: whole words first, then the hits only a word's beginning finds. */
const everyWord = async (
  store: SearchSteps,
  query: WordQuery,
  scope: SearchScope,
  { limit, newest }: { limit: number; newest: boolean },
  match: { whole: Match; beginnings: Match },
): Promise<{ items: SearchHit[]; hasMore: boolean }> => {
  const options = { mode: "every" as const, limit, newest }
  const whole = await store.matchWords(query, scope, { ...options, beginnings: false })
  if (whole.items.length >= limit) return { items: tagged(whole, match.whole), hasMore: whole.hasMore }
  const begun = await store.matchWords(query, scope, { ...options, beginnings: true })
  const seen = new Set(whole.items.map((hit) => hit.locator))
  const more = tagged(begun, match.beginnings).filter((hit) => !seen.has(hit.locator))
  const items = [...tagged(whole, match.whole), ...more]
  return { items: items.slice(0, limit), hasMore: items.length > limit || begun.hasMore }
}

/** Every plain word replaced by its corrections, when it has any; phrases and left-out words never are. */
const corrected = (query: WordQuery, corrections: Map<string, string[]>): WordQuery => ({
  ...query,
  required: query.required.map((group) =>
    group.flatMap((term): Term[] =>
      term.kind === "word" && corrections.has(term.text)
        ? (corrections.get(term.text) ?? []).map((text) => ({ kind: "word", text }))
        : [term],
    ),
  ),
})

/**
 * The search, in the order of plan S4: every word, topped up by word beginnings; then typo
 * correction; then any word, unless the query chose with OR; then the substring index. Each step
 * runs only when the one before found nothing. Until the word index is built, substring alone.
 */
export const search = async (
  store: SearchSteps,
  query: WordQuery,
  scope: SearchScope,
  { limit, newest = false }: { limit: number; newest?: boolean },
): Promise<SearchAnswer> => {
  const answer = (found: { items: SearchHit[]; hasMore: boolean }, rest: Partial<SearchAnswer> = {}) => ({
    corrections: [],
    wordsReady: true,
    ...found,
    ...rest,
  })
  if (query.required.length === 0) {
    const page = await store.matchFilters(scope, { limit })
    return answer({ items: tagged(page, "filters"), hasMore: page.hasMore })
  }
  if (!(await store.searchIndexState())?.ready) {
    const page = await store.matchSubstring(query, scope, { limit })
    return answer({ items: tagged(page, "substring"), hasMore: page.hasMore }, { wordsReady: false })
  }

  const options = { limit, newest }
  const found = await everyWord(store, query, scope, options, { whole: "words", beginnings: "beginnings" })
  if (found.items.length > 0) return answer(found)

  const plain = query.required.flat().flatMap((term) => (term.kind === "word" ? [term.text] : []))
  const corrections = await correctWords(store, [...new Set(plain)])
  const listed = [...corrections].map(([from, to]) => ({ from, to }))
  const fixed = corrections.size > 0 ? corrected(query, corrections) : query
  if (corrections.size > 0) {
    const repaired = await everyWord(store, fixed, scope, options, { whole: "corrected", beginnings: "corrected" })
    if (repaired.items.length > 0) return answer(repaired, { corrections: listed })
  }

  const chose = query.required.some((group) => group.length > 1)
  if (!chose && query.required.length > 1) {
    const any = await store.matchWords(fixed, scope, { mode: "any", beginnings: true, limit, newest })
    if (any.items.length > 0)
      return answer({ items: tagged(any, "anyWord"), hasMore: any.hasMore }, { corrections: listed })
  }

  // The raw text is searched as typed: a correction is a guess about words, not about pieces of them.
  const page = await store.matchSubstring(query, scope, { limit })
  return answer({ items: tagged(page, "substring"), hasMore: page.hasMore })
}
