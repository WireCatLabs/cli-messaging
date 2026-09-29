import { describe, expect, it } from "vitest"
import { terminalQr } from "./qr.js"

describe("terminalQr", () => {
  it("draws two modules per cell, black on white whatever the theme, with a quiet zone", () => {
    const { text, width } = terminalQr("tg://login?token=abc")
    const lines = text.split("\n")

    // Version 1 is 21 modules; the quiet zone adds four on each side.
    expect(width).toBeGreaterThanOrEqual(21 + 8)
    expect(lines).toHaveLength(Math.ceil(width / 2))
    for (const line of lines) {
      expect(line.startsWith("\x1b[30;107m") && line.endsWith("\x1b[0m")).toBe(true)
      const cells = line.slice("\x1b[30;107m".length, -"\x1b[0m".length)
      expect(cells).toHaveLength(width)
      expect(cells).toMatch(/^[█▀▄ ]+$/)
    }
    expect(lines[0]).toBe(`\x1b[30;107m${" ".repeat(width)}\x1b[0m`)
  })

  it("grows with what it carries", () => {
    expect(terminalQr("x".repeat(200)).width).toBeGreaterThan(terminalQr("x").width)
  })
})
