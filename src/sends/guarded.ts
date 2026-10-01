import { AsyncLocalStorage } from "node:async_hooks"
import type { Id } from "../domain/models.js"
import type { SendGuard } from "./guard.js"
import type { SendEntry } from "./journal.js"
import type { PermissionKey } from "./permissions.js"

/** `personIds` reach the guard's recipient check and never the journal. */
type Attempt = Omit<SendEntry, "at" | "profile" | "outcome"> & {
  operationId: string
  key?: PermissionKey
  personIds?: Id[]
}

/** A write's answer, with the id its journal lines and run events carry. */
export type Operated<T> = T & { operationId: string }

const current = new AsyncLocalStorage<string>()

/** A write that has gone and not been answered: `cut` records it as an unknown outcome, once. */
export interface WriteInFlight {
  operationId: string
  cut: () => void
}

/**
 * The writes in flight inside one command's deadline (`withDeadline`). A deadline that ends the
 * command while one is out cannot say "timeout" — the messenger may have carried it out — so it
 * cuts each into an unknown outcome. Per deadline, not per process: an MCP server runs many.
 */
export const writesInFlight = new AsyncLocalStorage<Set<WriteInFlight>>()

/** The write in progress, so the run events of the calls it makes name it without the port passing it along. */
export const currentOperation = (): string | undefined => current.getStore()

/**
 * **Checked before it goes, recorded after, on every outcome** — the shape of every write. The chat
 * must already be resolved and the adapter's method found: a throw between `check` and `record`
 * would leave a reservation counted against the hourly limit.
 */
export const guardedWrite = async <T>(
  guard: SendGuard,
  attempt: Attempt,
  act: () => Promise<T>,
  settled: (done: T) => Partial<Attempt> = () => ({}),
): Promise<T> => {
  try {
    await guard.ask?.(attempt)
    guard.check(attempt)
  } catch (error) {
    guard.record({ ...attempt, outcome: "refused", errorCode: codeOf(error) })
    throw error
  }
  let recorded = false
  const once = (entry: Parameters<SendGuard["record"]>[0]) => {
    if (recorded) return
    recorded = true
    guard.record(entry)
  }
  const flight: WriteInFlight = {
    operationId: attempt.operationId,
    cut: () => once({ ...attempt, outcome: "outcome_unknown", errorCode: "outcome_unknown" }),
  }
  const scope = writesInFlight.getStore()
  scope?.add(flight)
  try {
    const done = await current.run(attempt.operationId, act)
    once({ ...attempt, ...settled(done), outcome: "sent" })
    return done
  } catch (error) {
    const code = codeOf(error)
    once({ ...attempt, outcome: code === "outcome_unknown" ? "outcome_unknown" : "failed", errorCode: code })
    throw error
  } finally {
    scope?.delete(flight)
  }
}

export const codeOf = (error: unknown): string =>
  typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "unknown"
