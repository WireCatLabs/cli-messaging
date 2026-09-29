import jsqr from "jsqr"
import { PNG } from "pngjs"
import { describe, expect, it } from "vitest"
import { qrPng, terminalQr } from "./qr.js"

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

describe("qrPng", () => {
  it("**decodes, with decoders of its own, to the link it was given**", () => {
    const link = "tg://login?token=not-a-real-token-for-the-test"
    const image = PNG.sync.read(Buffer.from(qrPng(link)))

    // jsqr is CommonJS with an ES default in its types: the function is `.default` under NodeNext.
    const found = jsqr.default(new Uint8ClampedArray(image.data), image.width, image.height)
    expect(found?.data).toBe(link)
    expect(image.width).toBe(terminalQr(link).width * 8)
  })
})
