import { normalize } from "../store/normalize.js"
import { trigrams } from "./trigrams.js"

/** What correction needs of the store: the vocabulary, never the messages. */
export interface Vocabulary {
  knownTerms(terms: string[]): Promise<Set<string>>
  termCandidates(
    trigrams: string[],
    lengths: { shortest: number; longest: number },
  ): Promise<{ term: string; docs: number }[]>
}

/** One edit for a word of up to four letters, two above: a short word has few letters to spare. */
export const maxEdits = (word: string): number => (word.length <= 4 ? 1 : 2)

/**
 * Optimal string alignment — Levenshtein plus a swap of two neighbours, the commonest typo — that
 * gives up as soon as the distance passes `max`.
 */
export const editDistance = (a: string, b: string, max: number): number => {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let before = new Array<number>(b.length + 1).fill(0)
  let previous = Array.from({ length: b.length + 1 }, (_, at) => at)
  let current = new Array<number>(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    current[0] = i
    let lowest = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let value = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        (previous[j - 1] as number) + cost,
      )
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, (before[j - 2] as number) + 1)
      }
      current[j] = value
      lowest = Math.min(lowest, value)
    }
    if (lowest > max) return max + 1
    ;[before, previous, current] = [previous, current, before]
  }
  return previous[b.length] as number
}

/**
 * The words the store does not know, each with its nearest known words: the smallest distance wins,
 * then the most frequent, at most five (as the prototype measured, `bench/search/common.ts`). A word
 * with no close neighbour, or made of digits, is left as it is.
 */
export const correctWords = async (vocabulary: Vocabulary, words: string[]): Promise<Map<string, string[]>> => {
  const corrections = new Map<string, string[]>()
  const known = await vocabulary.knownTerms(words)
  for (const typed of words) {
    const word = normalize(typed)
    if (known.has(typed) || /^\d*$/.test(word)) continue
    const max = maxEdits(word)
    const near = (
      await vocabulary.termCandidates(trigrams(word), { shortest: word.length - max, longest: word.length + max })
    )
      .map((candidate) => ({ ...candidate, distance: editDistance(word, candidate.term, max) }))
      .filter((candidate) => candidate.distance <= max)
    if (near.length === 0) continue
    const nearest = Math.min(...near.map((candidate) => candidate.distance))
    corrections.set(
      typed,
      near
        .filter((candidate) => candidate.distance === nearest)
        .sort((a, b) => b.docs - a.docs)
        .slice(0, 5)
        .map((candidate) => candidate.term),
    )
  }
  return corrections
}
