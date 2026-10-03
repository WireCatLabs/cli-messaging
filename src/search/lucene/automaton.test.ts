import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { compileAutomaton, wildcardPattern } from "./automaton.js"

interface Fixture {
  pattern: string
  parsed: boolean
  matches?: string[]
}
const fixtures: Fixture[] = JSON.parse(readFileSync(new URL("./regex-reference.json", import.meta.url), "utf8"))
const samples = [
  "",
  "alpha",
  "beta",
  "a",
  "aa",
  "b",
  "ab",
  "abc",
  "123",
  "d",
  "a1",
  "_",
  "α",
  "😀",
  " ",
  "\t",
  "\n",
  "a/b",
  "a.b",
  "*",
  "^a$",
  "aaaaab",
  "A",
]
const unsupported = new Set(["a&b", "~a", "<01-12>", "<named>", "[^\\D]", "(?=a)", "(?:a)"])
describe("Lucene 9.12.3 regex subset", () => {
  for (const row of fixtures)
    it(`matches upstream: ${JSON.stringify(row.pattern)}`, () => {
      if (unsupported.has(row.pattern)) expect(() => compileAutomaton(row.pattern)).toThrow()
      else if (!row.parsed) expect(() => compileAutomaton(row.pattern)).toThrow()
      else {
        const automaton = compileAutomaton(row.pattern)
        expect(samples.filter((sample) => automaton.test(sample))).toEqual(row.matches)
      }
    })
  it("escapes wildcard literals and respects whole-term matching", () => {
    const literal = compileAutomaton(wildcardPattern("a\\*?"))
    expect(literal.test("a*x")).toBe(true)
    expect(literal.test("axx")).toBe(false)
    expect(compileAutomaton(wildcardPattern("alph*")).test("alpha")).toBe(true)
    expect(compileAutomaton(wildcardPattern("alpha")).test("xalpha")).toBe(false)
    expect(() => wildcardPattern("a\\")).toThrow("invalid_escape")
  })
  it("bounds pattern size, nesting, repetition/state expansion and total match work", () => {
    expect(() => compileAutomaton("x".repeat(1025))).toThrow("pattern")
    expect(() => compileAutomaton("a{10001}")).toThrow("states")
    expect(() => compileAutomaton("(ab){9999}")).toThrow("states")
    expect(() => compileAutomaton(`${"(".repeat(33)}a${")".repeat(33)}`)).toThrow("depth")
    const matcher = compileAutomaton("(a+)+b")
    expect(() => matcher.test("a".repeat(100), { work: 0, maxWork: 50 })).toThrow("work")
    expect(matcher.test("aaaaab")).toBe(true)
  })
})
