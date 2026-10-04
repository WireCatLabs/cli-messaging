/** Bump when the output changes for any input: rows carry the version that produced their copy. */
export const NORMALIZER_VERSION = 1

/** The letter part of `normalize`, without its whitespace folding, so one character of a pattern can be folded. */
export const fold = (text: string): string =>
  text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .normalize("NFC")
    .toLowerCase()

/**
 * The searchable copy of a message's text; the original is kept as it was. Stripping marks after
 * NFKD also folds ё into е and й into и, which merges real words (мой/мои, año/ano) — the ruling
 * accepts that price for search that ignores accents.
 */
export const normalize = (text: string): string =>
  fold(text)
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
