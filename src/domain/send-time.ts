import { CliError } from "@leemour/cli-core"

const MINUTE = 60_000
const YEAR = 365 * 24 * 60 * MINUTE
const DELAY = /^(\d+)(m|h|d)$/
const UNIT_MS: Record<string, number> = { m: MINUTE, h: 60 * MINUTE, d: 24 * 60 * MINUTE }

/**
 * `--at-time`: a time like `2026-09-25T09:00`, or a delay like `30m`, `2h`, `1d`, as an ISO time — the
 * same words max-cli takes. Rounded down to the minute, because messengers send at the start of it
 * (MAX measured, max-cli `FIND-141`), so the time printed is the time it goes. A time without an
 * offset is local, which is how `Date.parse` reads one with a clock and no zone.
 */
export const sendTime = (value: string, now = Date.now()): string => {
  const trimmed = value.trim()
  const [, amount, unit] = DELAY.exec(trimmed) ?? []
  const at = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(trimmed)
    ? Date.parse(trimmed.replace(" ", "T"))
    : amount && unit
      ? now + Number(amount) * (UNIT_MS[unit] ?? 0)
      : Number.NaN
  if (Number.isNaN(at)) {
    throw new CliError(
      "validation_error",
      `--at-time takes a time like 2026-09-25T09:00 or a delay like 30m, 2h, 1d — not "${value}"`,
    )
  }
  if (at < now + MINUTE) throw new CliError("validation_error", "--at-time has to be at least a minute from now")
  if (at > now + YEAR) throw new CliError("validation_error", "--at-time can be at most a year from now")
  return new Date(at - (at % MINUTE)).toISOString()
}
