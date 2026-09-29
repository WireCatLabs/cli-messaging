import type { SendGuard } from "./guard.js"
import type { SendEntry } from "./journal.js"

type Attempt = Omit<SendEntry, "at" | "profile" | "outcome">

/**
 * **Checked before it goes, recorded after, on every outcome** — the shape of every write that is
 * not a message send. The chat must already be resolved and the adapter's method found: a throw
 * between `check` and `record` would leave a reservation counted against the hourly limit.
 */
export const guardedWrite = async <T>(
  guard: SendGuard,
  attempt: Attempt,
  act: () => Promise<T>,
  settled: (done: T) => Partial<Attempt> = () => ({}),
): Promise<T> => {
  try {
    guard.check(attempt)
  } catch (error) {
    guard.record({ ...attempt, outcome: "refused", errorCode: codeOf(error) })
    throw error
  }
  try {
    const done = await act()
    guard.record({ ...attempt, ...settled(done), outcome: "sent" })
    return done
  } catch (error) {
    const code = codeOf(error)
    guard.record({ ...attempt, outcome: code === "outcome_unknown" ? "outcome_unknown" : "failed", errorCode: code })
    throw error
  }
}

export const codeOf = (error: unknown): string =>
  typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "unknown"
