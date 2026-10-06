import { describe, expect, it } from "vitest"
import { type HttpConfirmation, httpConfirmationOf, httpServerOptions } from "./policy.js"

describe("HTTP confirmation policy", () => {
  it.each([
    [{ httpConfirmation: "permissions" }, "needs --http"],
    [{ http: true, httpConfirmation: "automatic" }, "required or permissions"],
    [{ http: true, httpConfirmation: "permissions", confirmSend: true }, "conflicts"],
  ])("rejects invalid startup options %j", (flags, message) => {
    expect(() => httpConfirmationOf(flags)).toThrow(message)
  })
  it("refuses an unknown mode supplied by a JavaScript SDK caller", () => {
    expect(() => httpServerOptions("automatic" as HttpConfirmation)).toThrow("required or permissions")
  })
  it("defaults to required and drops the stdio bypasses in both modes", () => {
    expect(httpServerOptions(httpConfirmationOf({ http: true }))).toEqual({
      confirmSend: true,
      yes: false,
      allowDangerous: false,
    })
    expect(httpServerOptions(httpConfirmationOf({ http: true, httpConfirmation: "permissions" }))).toEqual({
      confirmSend: false,
      yes: false,
      allowDangerous: false,
    })
  })
})
