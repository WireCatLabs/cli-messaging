import { CliError } from "@leemour/cli-core"
import { isMoment, momentOf } from "../../services/moment.js"
import type { After } from "./port.js"

/** Ids are opaque to us — digits in Telegram and MAX, anything in another messenger — so only a moment's shape is a time. */
export const afterOf = (reference: string, flag = "--after"): After => {
  const wanted = reference.trim()
  if (isMoment(wanted)) return { time: momentOf(wanted, flag) }
  if (!isId(wanted)) {
    throw new CliError(
      "validation_error",
      `${flag} takes a message id, an ISO 8601 time or 30m, 2h, 1d ago — not "${wanted}"`,
    )
  }
  return { id: wanted }
}

const isId = (value: string) => value !== "" && !/[\s\p{Cc}]/u.test(value)

export const oneDirection = (before: string | undefined, after: string | undefined): void => {
  if (before !== undefined && after !== undefined) {
    throw new CliError("validation_error", "--before and --after are two directions; give one of them")
  }
}

/** A list reads one way from one place: at most one of `--before-id`, `--before-time`, `--after-id`, `--after-time`. */
export const listStart = (
  beforeId?: string,
  afterId?: string,
  afterTime?: string,
  beforeTime?: string,
): After | undefined => {
  const given = [
    beforeId === undefined ? undefined : "--before-id",
    beforeTime === undefined ? undefined : "--before-time",
    afterId === undefined ? undefined : "--after-id",
    afterTime === undefined ? undefined : "--after-time",
  ].filter((flag) => flag !== undefined)
  if (given.length > 1) {
    throw new CliError("validation_error", `${given.join(" and ")} are two starting points; give one of them`)
  }
  if (afterTime !== undefined) return { time: momentOf(afterTime, "--after-time") }
  if (afterId === undefined) return undefined
  const id = afterId.trim()
  if (!isId(id)) throw new CliError("validation_error", `--after-id takes a message id — not "${afterId}"`)
  return { id }
}
