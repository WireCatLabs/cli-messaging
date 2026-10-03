import { describe, expect, it } from "vitest"
import { validateFormattedText } from "./formatting.js"

describe("provider formatting boundaries", () => {
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
