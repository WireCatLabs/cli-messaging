import { CliError } from "@leemour/cli-core"
import { momentOf } from "./inbox.js"
import type { After } from "./port.js"

/** By shape, as `momentOf` decides: digits alone are a message id, never the year 12345. */
export const afterOf = (reference: string, flag = "--after"): After =>
  /^\d+$/.test(reference.trim()) ? { id: reference.trim() } : { time: momentOf(reference, flag) }

export const oneDirection = (before: string | undefined, after: string | undefined): void => {
  if (before !== undefined && after !== undefined) {
    throw new CliError("validation_error", "--before and --after are two directions; give one of them")
  }
}
