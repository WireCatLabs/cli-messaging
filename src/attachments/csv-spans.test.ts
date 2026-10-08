import { describe, expect, it } from "vitest"
import { delimitedSpans } from "./csv-spans.js"

describe("CSV source ranges", () => {
  it("keeps row/column provenance through escaped quotes, delimiters and quoted line breaks", () => {
    const text = 'name,value\r\n"Alpha, team","line one\nline ""two"""\r\n'
    const found = delimitedSpans(text, ",")
    expect(
      found.cells.map((span) => ({ row: span.row, column: span.column, text: text.slice(span.start, span.end) })),
    ).toEqual([
      { row: 1, column: 1, text: "name" },
      { row: 1, column: 2, text: "value" },
      { row: 2, column: 1, text: '"Alpha, team"' },
      { row: 2, column: 2, text: '"line one\nline ""two"""' },
    ])
    expect(delimitedSpans(text, ",", 2)).toMatchObject({ truncated: true })
    expect(() => delimitedSpans('"unclosed', ",")).toThrow("unclosed")
  })
})
