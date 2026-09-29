import type { Range } from "../../store/store.js"

export interface Estimate {
  /** Messages the store holds of the chat. */
  held: number
  ranges: Range[]
  /** Messages a full backfill would still fetch — `null` when nothing held gives a density to go on. */
  missing: number | null
  requests: number | null
  /** Runs at this `--max` to finish. */
  runs: number | null
  seconds: number | null
}

/** A request's own round trip, on top of `--pace`: Telegram's history answers in a few hundred ms. */
const REQUEST_MS = 400

/**
 * **What a full backfill would still cost, from the store alone** — no request. Message ids leave
 * gaps (deletions, and in private chats and small groups one counter across the whole account), so
 * the ids not held are priced at the density of the stretches that are: an estimate, never a count.
 */
export const estimateBackfill = ({
  ranges,
  held,
  newest,
  page,
  max,
  pauseMs,
}: {
  ranges: Range[]
  held: number
  /** The newest message id the store holds of the chat, held stretch or not. */
  newest: number | undefined
  page: number
  max: number
  pauseMs: number
}): Estimate => {
  const lowest = ranges[0]
  const top = ranges.at(-1)
  if (!lowest || !top) return { held, ranges, missing: null, requests: null, runs: null, seconds: null }

  const covered = ranges.reduce((sum, range) => sum + range.to - range.from + 1, 0)
  const between = ranges.slice(1).reduce((sum, range, index) => sum + range.from - (ranges[index]?.to ?? 0) - 1, 0)
  const gapIds = lowest.from - 1 + between + Math.max(0, (newest ?? top.to) - top.to)
  const inRanges = Math.min(held, covered)
  const missing = gapIds === 0 ? 0 : Math.round((inRanges / covered) * gapIds)
  // Each held stretch below the newest costs one request to step over.
  const requests = missing === 0 ? 0 : Math.ceil(missing / page) + ranges.length
  return {
    held,
    ranges,
    missing,
    requests,
    runs: Math.ceil(missing / max),
    seconds: Math.round((requests * (pauseMs + REQUEST_MS)) / 1000),
  }
}
