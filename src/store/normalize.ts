/** Bump when the output changes for any input: rows carry the version that produced their copy. */
export const NORMALIZER_VERSION = 1

/**
 * The searchable copy of a message's text; the original is kept as it was. Stripping marks after
 * NFKD also folds ё into е and й into и, which merges real words (мой/мои, año/ano) — the ruling
 * accepts that price for search that ignores accents.
 */
export const normalize = (text: string): string =>
  text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
