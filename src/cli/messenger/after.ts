import { CliError } from "@leemour/cli-core"
import { isMoment, momentOf } from "../../services/moment.js"
import type { After } from "./port.js"

/** Ids are opaque to us — digits in Telegram and MAX, anything in another messenger — so only a moment's shape is a time. */
export const afterOf = (reference: string, flag = "--after"): After => {
  const wanted = reference.trim()
  if (isMoment(wanted)) return { time: momentOf(wanted, flag) }
  if (wanted === "" || /[\s\p{Cc}]/u.test(wanted)) {
    throw new CliError(
      "validation_error",
      `${flag} takes a message id, an ISO 8601 time or 30m, 2h, 1d ago — not "${wanted}"`,
    )
  }
  return { id: wanted }
}

export const oneDirection = (before: string | undefined, after: string | undefined): void => {
  if (before !== undefined && after !== undefined) {
    throw new CliError("validation_error", "--before and --after are two directions; give one of them")
  }
}
