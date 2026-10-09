import { describe, expect, it } from "vitest"
import { validateFormattedText, visibleFormattedText } from "./formatting.js"

describe("provider formatting boundaries", () => {
  it("makes decoded hidden controls visible and keeps UTF-16 spans aligned, including subdivision flags", () => {
    const flag = "\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}"
    const text = `a\u{e0041}b${flag}\ufeffc`
    const from = "a\u{e0041}".length
    const result = visibleFormattedText({
      text,
      spans: [
        { type: "bold", from, length: 1 },
        { type: "link", from: from + 1, length: flag.length, url: "https://example.test/\u202e" },
        { type: "italic", from: text.length - 1, length: 1 },
      ],
    })
    expect(result.text).toBe(`a\\u{e0041}b${flag}\\ufeffc`)
    expect(result.spans[0]).toMatchObject({ from: "a\\u{e0041}".length, length: 1 })
    expect(
      result.text.slice(result.spans[1]?.from, (result.spans[1]?.from ?? 0) + (result.spans[1]?.length ?? 0)),
    ).toBe(flag)
    expect(result.spans[1]?.url).toBe("https://example.test/\\u202e")
    expect(result.spans[2]).toMatchObject({ from: result.text.length - 1, length: 1 })
    expect(visibleFormattedText({ text: "ordinary", spans: [] })).toEqual({ text: "ordinary", spans: [] })
  })
  it("accepts semantic spans without interpreting a messenger dialect", () => {
    const input = {
      text: "🧪 label",
      spans: [{ type: "link" as const, from: 3, length: 5, url: "https://example.test" }],
    }
    expect(validateFormattedText(input)).toBe(input)
  })
  it.each([-1, 0.5, 2, 20])("refuses an invalid UTF-16 start %s", (from) => {
    expect(() => validateFormattedText({ text: "a🧪b", spans: [{ type: "bold", from, length: 1 }] })).toThrow()
  })
  it("refuses a range ending inside an emoji, oversized span lists and unsafe links", () => {
    expect(() => validateFormattedText({ text: "🧪", spans: [{ type: "bold", from: 0, length: 1 }] })).toThrow()
    expect(() =>
      validateFormattedText({
        text: "x",
        spans: Array.from({ length: 101 }, () => ({ type: "bold", from: 0, length: 1 })),
      }),
    ).toThrow()
    for (const url of ["javascript:alert(1)", "file:///tmp/x", "/relative", "https://example.test/\npath"])
      expect(() => validateFormattedText({ text: "x", spans: [{ type: "link", from: 0, length: 1, url }] })).toThrow()
  })
})
