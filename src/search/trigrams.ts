/**
 * The pieces a word is looked up by when it may be misspelt. Padded at the start twice and at the end
 * once, as the prototype measured (`bench/search/common.ts`): a typo in the first letters still shares
 * pieces with the right word.
 */
export const trigrams = (term: string): string[] => {
  const padded = `  ${term} `
  const pieces = new Set<string>()
  for (let at = 0; at + 3 <= padded.length; at++) pieces.add(padded.slice(at, at + 3))
  return [...pieces]
}
