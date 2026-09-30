import { setTimeout as sleep } from "node:timers/promises"
import type { Command } from "commander"
import { environmentOf } from "../context.js"
import { isCliFailure } from "../failures.js"

/** Waits longer than this are not sat out: the run stops, and the next one resumes. */
const LONGEST_WAIT_MS = 5 * 60 * 1000

/** Ctrl-C and SIGTERM — which `store jobs cancel` sends — end a long run after the step in hand. */
export const stopOnSignal = (command: Command): { signal: AbortSignal; release: () => void } => {
  const stop = new AbortController()
  const given = environmentOf(command).signal
  const end = () => stop.abort()
  given?.addEventListener("abort", end, { once: true })
  const signals = given ? [] : (["SIGINT", "SIGTERM"] as const)
  for (const name of signals) process.once(name, end)
  return {
    signal: stop.signal,
    release: () => {
      for (const name of signals) process.off(name, end)
      given?.removeEventListener("abort", end)
    },
  }
}

/** Sits out a provider's "wait N seconds" when it is short, a few times; a long one ends the run. */
export const patiently = async <T>(
  request: () => Promise<T>,
  note: (message: string) => void,
  stop: AbortSignal,
): Promise<T> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await request()
    } catch (error) {
      const wait = isCliFailure(error) && error.code === "rate_limited" ? Number(error.details?.retryAfterMs) : NaN
      if (!Number.isFinite(wait) || wait > LONGEST_WAIT_MS || attempt >= 3) throw error
      note(`asked to wait ${Math.ceil(wait / 1000)} s — waiting, then going on`)
      await sleep(wait, undefined, { signal: stop }).catch(() => {})
      if (stop.aborted) throw error
    }
  }
}
