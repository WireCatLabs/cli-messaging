import { describe, expect, it } from "vitest"
import { normalize } from "./normalize.js"

describe("normalize", () => {
  it.each([
    ["счёт", "счет"],
    ["Йогурт", "иогурт"],
    ["València", "valencia"],
    ["¿Alguien conoce un buen gestor en València?", "¿alguien conoce un buen gestor en valencia?"],
    ["ﬁle ①", "file 1"],
    ["İstanbul", "istanbul"],
  ])("folds %j into %j", (text, expected) => {
    expect(normalize(text)).toBe(expected)
  })

  it("turns control characters and mixed whitespace into single spaces", () => {
    expect(normalize("  one\ttwo\r\n\u0000three  four\u0085 ")).toBe("one two three four")
  })

  it("keeps each language of a mixed message", () => {
    expect(normalize("Встреча в Café Olé — tomorrow, ¿vale?")).toBe("встреча в cafe ole — tomorrow, ¿vale?")
  })

  it("leaves text that is already normalized unchanged", () => {
    const once = normalize("Ёжик ﬁnds  Ñandú\tТЕКСТ")
    expect(normalize(once)).toBe(once)
  })
})
