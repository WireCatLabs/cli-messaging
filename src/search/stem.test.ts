import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { normalize } from "../store/normalize.js"
import { openSqlite } from "../store/sqlite/open.js"
import EnglishStemmer from "./snowball/english-stemmer.js"
import RussianStemmer from "./snowball/russian-stemmer.js"
import SpanishStemmer from "./snowball/spanish-stemmer.js"
import { analyzerIdentity, createStemmer, DEFAULT_STEMMERS, parseStemmers, type Stemmers } from "./stem.js"

const stem = createStemmer()
const stemmed = (stemmers: Stemmers) => createStemmer(stemmers).stemToken

describe("the vendored Snowball stemmers", () => {
  it.each([
    ["russian", RussianStemmer],
    ["spanish", SpanishStemmer],
    ["english", EnglishStemmer],
  ])("give snowball-data's expected output for the %s sample", (language, Stemmer) => {
    const engine = new Stemmer()
    const sample = readFileSync(join(import.meta.dirname, "snowball/samples", `${language}.tsv`), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t") as [string, string])
    const wrong = sample.filter(([word, expected]) => engine.stemWord(word) !== expected)
    expect(sample).toHaveLength(2000)
    expect(wrong).toEqual([])
  })
})

describe("createStemmer with the default choices", () => {
  it.each([
    [["квартира", "квартиру", "квартиры"], "квартир"],
    [["ёлка", "елка", "ёлки"], "елк"],
    [["мой", "мои"], "мо"],
    [["alquilar", "alquilo", "alquilaron"], "alquil"],
    [["piso", "pisos"], "pis"],
    [["canción", "canciones", "cancion"], "cancion"],
  ])("stems %j to %j", (words, expected) => {
    expect(words.map(stem.stemToken)).toEqual(words.map(() => expected))
  })

  it("keeps a derived word apart from its base", () => {
    expect(stem.stemToken("квартирант")).toBe("квартирант")
  })

  it("stems before folding, so й and accents are folded in the stem, not in the word Snowball sees", () => {
    expect(stem.stemToken("йогурт")).toBe("иогурт")
    expect(stem.stemToken("año")).toBe("ano")
  })

  it.each([
    ["часть", "часто", "част"],
    ["caso", "casa", "cas"],
  ])("merges %s and %s into %s — a documented false merge", (a, b, expected) => {
    expect([stem.stemToken(a), stem.stemToken(b)]).toEqual([expected, expected])
  })

  it("stems English as Spanish by default", () => {
    expect(stem.stemToken("running")).toBe("running")
  })

  it("strips a stress mark before stemming", () => {
    expect(stem.stemToken("кварти\u0301ру")).toBe("квартир")
  })

  it("lowercases and composes its input", () => {
    expect(stem.stemToken("КВАРТИРУ")).toBe("квартир")
    expect(stem.stemToken("cancio\u0301n")).toBe("cancion")
  })
})

describe("routing by script", () => {
  it.each([
    ["москвa", "a Cyrillic word with a Latin a"],
    ["covid19", "a word with a digit"],
    ["квартира2", "a Cyrillic word with a digit"],
    ["ελλάδες", "a Greek word"],
    ["2026", "a number"],
  ])("leaves %s as it is, folded — %s", (token) => {
    expect(stem.stemToken(token)).toBe(token.normalize("NFKD").replace(/\p{M}/gu, ""))
  })

  it("stems Ukrainian with the Russian stemmer", () => {
    expect(stem.stemToken("квартирою")).toBe("квартир")
  })

  it("gives a mark-only token nothing to index", () => {
    expect(stem.stemToken("\u0301")).toBe("")
  })
})

describe("the choices", () => {
  it("stems Latin words as English when chosen", () => {
    const english = stemmed({ cyrillic: "russian", latin: "english" })
    expect(["running", "runs", "run"].map(english)).toEqual(["run", "run", "run"])
    expect(english("canciones")).toBe("cancion")
    expect(english("квартиру")).toBe("квартир")
  })

  it("leaves a script unstemmed with none, still folded", () => {
    const none = stemmed({ cyrillic: "none", latin: "none" })
    expect(["квартиру", "ёлки", "canciones", "Año"].map(none)).toEqual(["квартиру", "елки", "canciones", "ano"])
    expect(stemmed({ cyrillic: "none", latin: "spanish" })("квартиру")).toBe("квартиру")
    expect(stemmed({ cyrillic: "russian", latin: "none" })("canciones")).toBe("canciones")
  })

  it("names what built an index", () => {
    expect(stem.identity).toBe("snowball-3.1.1 cyrillic=russian latin=spanish")
    expect(analyzerIdentity({ cyrillic: "none", latin: "english" })).toBe("snowball-3.1.1 cyrillic=none latin=english")
    expect(stem.stemmers).toEqual(DEFAULT_STEMMERS)
  })

  it("refuses a language of the other script, naming the allowed ones", () => {
    expect(() => parseStemmers({ cyrillic: "spanish" })).toThrow(
      expect.objectContaining({
        code: "validation_error",
        message: 'cyrillic words cannot be stemmed with "spanish" — choose russian, none',
        details: expect.objectContaining({ allowed: ["russian", "none"] }),
      }),
    )
    expect(() => createStemmer({ cyrillic: "russian", latin: "russian" } as never)).toThrow(/choose spanish, english/)
  })

  it("takes the default for a missing choice", () => {
    expect(parseStemmers({ latin: "english" })).toEqual({ cyrillic: "russian", latin: "english" })
    expect(parseStemmers(undefined)).toEqual(DEFAULT_STEMMERS)
  })
})

describe("stemTokens", () => {
  it("splits, stems and folds every word of a text", () => {
    expect(stem.stemTokens("Сдаю квартиру, ¿alquilaron el piso? covid19 🎉")).toEqual([
      "сда",
      "квартир",
      "alquil",
      "el",
      "pis",
      "covid19",
    ])
  })

  it("splits a text into the same words, in the same order, as the FTS5 word index", async () => {
    const text =
      "Кварти\u0301ру — ок! e-mail: a@b.es, don't snake_case 3.14 Москвa covid19 🎉 ﬁle Ёлки «año» x\u0301y (canción)"
    const { database } = await openSqlite(":memory:")
    database.exec(`CREATE VIRTUAL TABLE t USING fts5(x, tokenize = 'unicode61 remove_diacritics 2');
      CREATE VIRTUAL TABLE v USING fts5vocab(t, 'instance')`)
    database.prepare("INSERT INTO t (x) VALUES (?)").run(text)
    const fts = database
      .prepare("SELECT term FROM v ORDER BY offset")
      .all()
      .map((row) => normalize(String((row as { term: string }).term)))
    database.close()
    expect(createStemmer({ cyrillic: "none", latin: "none" }).stemTokens(text)).toEqual(fts)
  })
})

describe("the cache", () => {
  it("answers a repeated token as it answered it the first time", () => {
    const cached = createStemmer(DEFAULT_STEMMERS, { cacheLimit: 3 })
    const fresh = createStemmer(DEFAULT_STEMMERS, { cacheLimit: 0 })
    const words = ["квартиру", "pisos", "квартиру", "ёлки", "canciones", "мой", "pisos", "квартиру", "ёлки"]
    expect(words.map(cached.stemToken)).toEqual(words.map(fresh.stemToken))
    expect(words.map(cached.stemToken)).toEqual(words.map(fresh.stemToken))
  })

  it("is never shared between stemmers with different choices", () => {
    expect(createStemmer().stemToken("running")).toBe("running")
    expect(stemmed({ cyrillic: "russian", latin: "english" })("running")).toBe("run")
  })
})
