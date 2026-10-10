import { expect, it } from "vitest"
import { safeName } from "./file-download.js"

it("keeps valid POSIX names and applies Windows constraints only on Windows", () => {
  for (const name of ["CON.txt", "nul", "COM1.pdf", "LPT9"]) {
    expect(safeName(name, "win32")).toBeUndefined()
    expect(safeName(name, "linux")).toBe(name)
  }
  expect(safeName("report:stream. ", "win32")).toBe("report_stream")
  expect(safeName("report:stream. ", "linux")).toBe("report:stream. ")
  expect(safeName("report.pdf", "win32")).toBe("report.pdf")
})
