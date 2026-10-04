// Which stemmer implements today's Snowball Russian and Spanish: each candidate runs over the official
// test vocabulary (snowball-data voc.txt → output.txt), then over a handful of known words.
//
//   node stemmers.ts
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { DATA, normalize, official, out } from "./lib.ts"

const require = createRequire(import.meta.url)
const snowballStemmers = require("snowball-stemmers")
const natural = require("natural")

type Fn = (w: string) => string
const candidates: Record<"russian" | "spanish", Record<string, Fn>> = {
  russian: {
    "official Snowball 3.1.1 JS": (w) => official.ru.stemWord(w),
    "snowball-stemmers 0.6.0": (
      (s) => (w: string) =>
        s.stem(w)
    )(snowballStemmers.newStemmer("russian")),
    "natural 8.1.1 PorterStemmerRu": (w) => natural.PorterStemmerRu.stem(w),
  },
  spanish: {
    "official Snowball 3.1.1 JS": (w) => official.es.stemWord(w),
    "snowball-stemmers 0.6.0": (
      (s) => (w: string) =>
        s.stem(w)
    )(snowballStemmers.newStemmer("spanish")),
    "natural 8.1.1 PorterStemmerEs": (w) => natural.PorterStemmerEs.stem(w),
  },
}

const lines = (path: string) => readFileSync(path, "utf8").split("\n").filter(Boolean)

out("## Stemmer library check [run]")
out()
out("Official expected output: snowball-data a0ec0d0 `voc.txt` → `output.txt`.")
out()
out("| language | library | words | mismatches | mismatch % | of them with ё |")
out("|---|---|---|---|---|---|")
for (const lang of ["russian", "spanish"] as const) {
  const voc = lines(join(DATA, "snowball-data", lang, "voc.txt"))
  const expected = lines(join(DATA, "snowball-data", lang, "output.txt"))
  for (const [name, stem] of Object.entries(candidates[lang])) {
    let wrong = 0
    let yo = 0
    const examples: string[] = []
    voc.forEach((word, i) => {
      if (stem(word) === expected[i]) return
      wrong++
      if (word.includes("ё")) yo++
      if (examples.length < 3) examples.push(`${word}→${stem(word)} (want ${expected[i]})`)
    })
    out(
      `| ${lang} | ${name} | ${voc.length} | ${wrong} | ${((100 * wrong) / voc.length).toFixed(2)}% | ${yo}${examples.length ? ` — e.g. ${examples.join("; ")}` : ""} |`,
    )
  }
}

const probes = {
  russian: ["квартира", "квартиру", "квартиры", "квартирант", "ёлка", "елка", "ёлки", "стали", "сталь"],
  spanish: ["alquilar", "alquilo", "alquilaron", "piso", "pisos", "canción", "canciones", "cancion", "año", "ano"],
}
out()
out("Known words — `stem(lower(word))`, then `normalize()` of that stem (what the index stores):")
out()
for (const lang of ["russian", "spanish"] as const) {
  const names = Object.keys(candidates[lang])
  out(`| ${lang} word | ${names.join(" | ")} | official → normalize() |`)
  out(`|---|${names.map(() => "---|").join("")}---|`)
  for (const word of probes[lang]) {
    const stems = names.map((n) => (candidates[lang][n] as Fn)(word))
    out(`| ${word} | ${stems.join(" | ")} | ${normalize(stems[0] as string)} |`)
  }
  out()
}
