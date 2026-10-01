import type { Command } from "commander"
import { environmentOf } from "../context.js"

/** Ctrl-C and SIGTERM — which `store jobs cancel` sends — end a long run after the step in hand. */
export const stopOnSignal = (command: Command): { signal: AbortSignal; release: () => void } => {
  const stop = new AbortController()
  const given = environmentOf(command).signal
  const end = () => stop.abort()
  given?.addEventListener("abort", end, { once: true })
  const signals = given ? [] : (["SIGINT", "SIGTERM"] as const)
  // `on`, not `once`: mtcute closes its storage on the signal and then sends it again, which with no
  // listener left kills the process before its `finally` — a serve's lock outlived it.
  for (const name of signals) process.on(name, end)
  return {
    signal: stop.signal,
    release: () => {
      for (const name of signals) process.off(name, end)
      given?.removeEventListener("abort", end)
    },
  }
}
