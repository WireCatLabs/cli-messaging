import { CliError } from "@leemour/cli-core"
import type { FloodMemory } from "../../sends/flood.js"
import { isCliFailure } from "../failures.js"
import { providerErrorKey } from "../runs/events.js"
import { type AccountStanding, type MessengerAdapter, throughWrapper } from "./port.js"

const LONG_LIVED = new Set(["watch", "feed", "self", "newSendId", "close", "formatMarkdown", "formatHtml"])
const BLOCKING = new Set<AccountStanding["state"]>(["frozen", "limited"])

const chatOf = (args: unknown[]): string | undefined =>
  typeof args[0] === "string" && /^-?\d+$/.test(args[0]) ? args[0] : undefined

/**
 * The adapter, refusing a call the messenger already said to hold off on, before it is asked again;
 * remembering each new "wait" it answers; and stopping writes once it says the account may not write.
 * Never repeats a call: a send is the caller's to repeat, with its own send id.
 */
export const flooded = (
  messenger: MessengerAdapter,
  memory: FloodMemory,
  { name, warn }: { name: string; warn: (message: string) => void },
): MessengerAdapter => {
  const kept = (what: () => void) => {
    try {
      what()
    } catch (error) {
      warn(`could not remember ${name}'s wait (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  const noted = (operation: string, chatId: string | undefined, error: unknown) => {
    if (!isCliFailure(error)) return
    const details = error.details ?? {}
    const standing = details.standing as AccountStanding | undefined
    if (standing && BLOCKING.has(standing.state)) {
      kept(() => {
        const block = memory.block({
          state: standing.state as "frozen" | "limited",
          hint: standing.hint ?? error.message,
          ...(standing.until ? { until: standing.until } : {}),
        })
        warn(`writes from this profile are held until ${block.until}: ${block.hint}`)
      })
      return
    }
    const waitMs = Number(details.retryAfterMs)
    if (error.code !== "rate_limited" || details.remembered === true || !Number.isFinite(waitMs) || waitMs <= 0) return
    const providerError = providerErrorKey(details.providerError)
    kept(() => {
      const deadline = memory.remember({
        operation,
        ...(chatId ? { chatId } : {}),
        ...(providerError ? { providerError } : {}),
        waitMs,
      })
      warn(`${name} asked to wait before ${operation} again — until ${deadline.until}`)
    })
  }

  return throughWrapper(messenger, {} as MessengerAdapter, (operation, call) => {
    if (LONG_LIVED.has(operation)) return call as never
    return (async (...args: unknown[]) => {
      const chatId = chatOf(args)
      const owed = memory.owed(operation, chatId)
      if (owed) {
        const waitMs = Math.max(0, Date.parse(owed.until) - Date.now())
        throw new CliError(
          "rate_limited",
          `${name} asked to wait before ${operation} again, ${Math.ceil(waitMs / 1000)} s are left — nothing was sent to ${name}`,
          {
            retryAfterMs: waitMs,
            retryAt: owed.until,
            remembered: true,
            ...(owed.providerError ? { providerError: owed.providerError } : {}),
          },
        )
      }
      try {
        return await call(...args)
      } catch (error) {
        noted(operation, chatId, error)
        throw error
      }
    }) as never
  })
}
