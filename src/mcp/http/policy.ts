import { CliError } from "@leemour/cli-core"

export type HttpConfirmation = "required" | "permissions"

export const httpConfirmationOf = (flags: {
  http?: boolean
  httpConfirmation?: string
  confirmSend?: boolean
}): HttpConfirmation => {
  const mode = flags.httpConfirmation ?? "required"
  if (flags.httpConfirmation !== undefined && !flags.http)
    throw new CliError("validation_error", "--http-confirmation needs --http")
  if (mode !== "required" && mode !== "permissions")
    throw new CliError("validation_error", "--http-confirmation takes required or permissions")
  if (mode === "permissions" && flags.confirmSend)
    throw new CliError("validation_error", "--http-confirmation permissions conflicts with --confirm-send")
  return mode
}

/** HTTP never inherits the stdio flags that bypass questions at level ask. */
export const httpServerOptions = (mode: HttpConfirmation = "required") => ({
  confirmSend: mode === "required",
  yes: false,
  allowDangerous: false,
})
