// Match quality on a UD treebank: each sentence is a message, a lemma query is relevant to every sentence
// holding a token with the same (lemma, UPOS). Every row runs as real FTS5 queries without a limit.
//
//   node quality.ts syntagrus|ru-gsd|ancora|ewt
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  correctWords,
  DATA,
  editDistance,
  fmt,
  type LatinStemmer,
  maxEdits,
  mulberry32,
  normalize,
  type Order,
  out,
  quoted,
  stemQuery,
  stemTokens,
  tokenize,
  trigrams,
  words,
} from "./lib.ts"

const CORPORA: Record<string, { dir: string; label: string; language: string }> = {
  syntagrus: {
    dir: "UD_Russian-SynTagRus",
    label: "UD_Russian-SynTagRus r2.18 (CC BY-NC-SA 4.0)",
    language: "Russian",
  },
  "ru-gsd": { dir: "UD_Russian-GSD", label: "UD_Russian-GSD r2.18 (CC BY-SA 4.0)", language: "Russian" },
  ancora: { dir: "UD_Spanish-AnCora", label: "UD_Spanish-AnCora r2.18 (CC BY 4.0)", language: "Spanish" },
  ewt: { dir: "UD_English-EWT", label: "UD_English-EWT r2.18 (CC BY-SA 4.0)", language: "English" },
}
const name = process.argv[2] ?? ""
const corpus = CORPORA[name]
if (!corpus) throw new Error(`usage: node quality.ts ${Object.keys(CORPORA).join("|")}`)

const CONTENT = new Set(["NOUN", "VERB", "ADJ", "ADV", "PROPN"])
const PER_BAND = 34
const SEED = 42
const T1_CAP = 5

const held = <K, V>(map: Map<K, V>, key: K, make: () => V): V => {
  const found = map.get(key)
  if (found !== undefined) return found
  const made = make()
  map.set(key, made)
  return made
}

// ---- parse
const dir = join(DATA, "ud", corpus.dir)
const texts: string[] = []
const relevant = new Map<string, Set<number>>()
const forms = new Map<string, Map<string, string>>()
/** Every content token: its folded form, lemma key and the sentence — for the false-merge tally. */
const tokens: { form: string; key: string }[] = []
/** The lemma as written in the treebank (ё kept), lowercased: a query is stemmed before it is folded. */
const lemmaText = new Map<string, string>()
for (const file of readdirSync(dir)
  .filter((f) => f.endsWith(".conllu"))
  .sort()) {
  let text = ""
  let mwtEnd = 0
  let sentence: { form: string; lemma: string; upos: string; inMwt: boolean }[] = []
  const flush = () => {
    if (!text) return
    const id = texts.length + 1
    texts.push(text)
    for (const t of sentence) {
      if (!CONTENT.has(t.upos)) continue
      const key = `${normalize(t.lemma)}\t${t.upos}`
      if (!lemmaText.has(key)) lemmaText.set(key, t.lemma.normalize("NFC").toLowerCase())
      held(relevant, key, () => new Set()).add(id)
      if (t.inMwt) continue
      const lower = t.form.normalize("NFC").toLowerCase()
      if (!/^\p{L}+$/u.test(lower)) continue
      const seen = held(forms, key, () => new Map())
      if (!seen.has(normalize(lower))) seen.set(normalize(lower), lower)
      tokens.push({ form: lower, key })
    }
    text = ""
    sentence = []
  }
  for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
    if (line.startsWith("# text = ")) text = line.slice(9)
    else if (line === "") flush()
    else if (!line.startsWith("#")) {
      const [id = "", form = "", lemma = "", upos = ""] = line.split("\t")
      if (id.includes(".")) continue
      if (id.includes("-")) {
        mwtEnd = Number(id.split("-")[1])
        continue
      }
      sentence.push({ form, lemma, upos, inMwt: Number(id) <= mwtEnd })
    }
  }
  flush()
}

// ---- index: the product's word index, its typo vocabulary, and the candidate indexes
const db = new DatabaseSync(":memory:")
db.exec(`
CREATE VIRTUAL TABLE message_words USING fts5(normalized_text, scope, content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2', prefix = '3');
CREATE VIRTUAL TABLE message_words_vocab USING fts5vocab(message_words, 'col');
CREATE TABLE search_terms (term TEXT PRIMARY KEY, length INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE search_term_trigrams (trigram TEXT NOT NULL, length INTEGER NOT NULL, term TEXT NOT NULL,
  PRIMARY KEY (trigram, length, term)) WITHOUT ROWID;
CREATE VIRTUAL TABLE message_stems USING fts5(stems, content = '', tokenize = 'unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE message_stems_folded USING fts5(stems, content = '', tokenize = 'unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE message_stems_en USING fts5(stems, content = '', tokenize = 'unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE message_trigrams USING fts5(normalized_text, content = '', tokenize = 'trigram');
`)
const latinReference = name === "ewt"
const insert = (table: string, column: string) => db.prepare(`INSERT INTO ${table} (rowid, ${column}) VALUES (?, ?)`)
const ins = {
  words: db.prepare("INSERT INTO message_words (rowid, normalized_text, scope) VALUES (?, ?, '')"),
  stems: insert("message_stems", "stems"),
  folded: insert("message_stems_folded", "stems"),
  en: insert("message_stems_en", "stems"),
  tri: insert("message_trigrams", "normalized_text"),
}
const jsTerms = new Set<string>()
db.exec("BEGIN")
texts.forEach((text, i) => {
  const id = i + 1
  const normalized = normalize(text)
  for (const t of tokenize(normalized)) jsTerms.add(t)
  ins.words.run(id, normalized)
  ins.stems.run(id, stemTokens(text).join(" "))
  ins.folded.run(id, stemTokens(text, "fold-then-stem").join(" "))
  if (latinReference) ins.en.run(id, stemTokens(text, "stem-then-fold", "en").join(" "))
  ins.tri.run(id, normalized)
})
const term = db.prepare("INSERT OR IGNORE INTO search_terms (term, length) VALUES (?, ?)")
const tri = db.prepare("INSERT OR IGNORE INTO search_term_trigrams (trigram, length, term) VALUES (?, ?, ?)")
for (const row of db.prepare("SELECT term FROM message_words_vocab WHERE col = 'normalized_text'").all()) {
  const word = String(row.term)
  term.run(word, word.length)
  if (!/^\d+$/.test(word)) for (const piece of trigrams(word)) tri.run(piece, word.length, word)
}
db.exec("COMMIT")
const ftsTerms = Number(
  db.prepare("SELECT count(*) AS n FROM message_words_vocab WHERE col = 'normalized_text'").get()?.n,
)

// ---- rows
const context = { database: db }
const matchStmt = new Map<string, ReturnType<DatabaseSync["prepare"]>>()
const match = (table: string, expr: string): Set<number> => {
  const stmt = held(matchStmt, table, () => db.prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH ?`))
  return new Set(stmt.all(expr).map((r) => Number(r.rowid)))
}
const union = (...sets: Set<number>[]) => new Set(sets.flatMap((s) => [...s]))
const anyOf = (terms: string[]) => match("message_words", terms.map(quoted).join(" OR "))

const exact = (q: string) => anyOf([normalize(q)])
const neighbours = (word: string, cap: number) => {
  const max = maxEdits(word)
  if (word.length < 3) return []
  return words
    .termCandidates(context, trigrams(word), { shortest: Math.max(3, word.length - max), longest: word.length + max })
    .filter((c) => c.term !== word && editDistance(word, c.term, max) <= max)
    .sort((a, b) => b.docs - a.docs)
    .slice(0, cap)
    .map((c) => c.term)
}
const vocabulary = {
  knownTerms: async (t: string[]) => words.knownTerms(context, t),
  termCandidates: async (p: string[], l: { shortest: number; longest: number }) => words.termCandidates(context, p, l),
}
const stemmed = (table: string, q: string, order: Order = "stem-then-fold", latin: LatinStemmer = "es") => {
  const stem = stemQuery(q, order, latin)
  return stem ? match(table, quoted(stem)) : new Set<number>()
}

type Row = { name: string; run: (q: string) => Promise<Set<number>> | Set<number> }
const ROWS: Row[] = [
  { name: "Exact", run: exact },
  { name: "Exact+beginnings", run: (q) => match("message_words", `${quoted(normalize(q))}*`) },
  {
    name: "Prefix",
    run: (q) => {
      const stem = stemQuery(q)
      return stem.length >= 3 ? match("message_words", `${quoted(stem)}*`) : exact(q)
    },
  },
  {
    name: "T0",
    run: async (q) => {
      const corrected = (await correctWords(vocabulary, [q])).get(q)
      return corrected ? anyOf(corrected) : exact(q)
    },
  },
  { name: "T1", run: (q) => anyOf([normalize(q), ...neighbours(normalize(q), T1_CAP)]) },
  { name: "T1 (no cap)", run: (q) => anyOf([normalize(q), ...neighbours(normalize(q), Number.POSITIVE_INFINITY)]) },
  {
    name: "T2",
    run: (q) => (normalize(q).length >= 3 ? match("message_trigrams", quoted(normalize(q))) : exact(q)),
  },
  { name: "S", run: (q) => stemmed("message_stems", q) },
  { name: "S (fold, then stem)", run: (q) => stemmed("message_stems_folded", q, "fold-then-stem") },
  {
    name: "S+T1",
    run: (q) => union(stemmed("message_stems", q), anyOf([normalize(q), ...neighbours(normalize(q), T1_CAP)])),
  },
  ...(latinReference
    ? [{ name: "S (English stemmer)", run: (q: string) => stemmed("message_stems_en", q, "stem-then-fold", "en") }]
    : []),
]

// ---- queries: ~100 lemmas in three document-frequency bands, each asked as the lemma and as an attested form
const eligible = [...relevant.keys()]
  .filter((key) => {
    const lemma = key.split("\t")[0] as string
    return /^\p{L}{3,}$/u.test(lemma) && [...(forms.get(key)?.keys() ?? [])].some((f) => f !== lemma)
  })
  .sort((a, b) => (relevant.get(a)?.size ?? 0) - (relevant.get(b)?.size ?? 0) || (a < b ? -1 : 1))
const df = (key: string) => relevant.get(key)?.size ?? 0
// Fixed edges, not tertiles: most lemmas occur once, so tertiles put df 1 into two bands of three.
const BANDS = [
  { band: "rare", keys: eligible.filter((k) => df(k) >= 2 && df(k) <= 4) },
  { band: "medium", keys: eligible.filter((k) => df(k) >= 5 && df(k) <= 49) },
  { band: "common", keys: eligible.filter((k) => df(k) >= 50) },
]
const rand = mulberry32(SEED)
const sample = <T>(xs: T[], n: number) => {
  const a = [...xs]
  for (let i = 0; i < Math.min(n, a.length); i++) {
    const j = i + Math.floor(rand() * (a.length - i))
    ;[a[i], a[j]] = [a[j] as T, a[i] as T]
  }
  return a.slice(0, n)
}
type Score = { recall: number; retrieved: number; tp: number; gain: number }
const scores = new Map<string, Score[]>()
const record = (cell: string, s: Score) => {
  const list = scores.get(cell) ?? []
  list.push(s)
  scores.set(cell, list)
}
const bandRanges: string[] = []
for (const { band, keys } of BANDS) {
  const dfs = keys.map((k) => relevant.get(k)?.size ?? 0)
  bandRanges.push(`${band}: df ${Math.min(...dfs)}–${Math.max(...dfs)} (${keys.length} lemmas)`)
  for (const key of sample(keys, PER_BAND)) {
    const truth = relevant.get(key) as Set<number>
    const lemma = key.split("\t")[0] as string
    const attested = [...(forms.get(key) as Map<string, string>)].filter(([folded]) => folded !== lemma)
    const form = (attested[Math.floor(rand() * attested.length)] as [string, string])[1]
    for (const [kind, q] of [
      ["lemma", lemmaText.get(key) ?? lemma],
      ["form", form],
    ] as const) {
      let exactTp = 0
      for (const row of ROWS) {
        const got = await row.run(q)
        let tp = 0
        for (const id of got) if (truth.has(id)) tp++
        if (row.name === "Exact") exactTp = tp
        const s = { recall: tp / truth.size, retrieved: got.size, tp, gain: tp - exactTp }
        for (const cell of [`${row.name}|${band}|${kind}`, `${row.name}|all|${kind}`, `${row.name}|all|all`]) {
          record(cell, s)
        }
      }
    }
  }
}

const summary = (cell: string) => {
  const list = scores.get(cell) ?? []
  const recall = list.reduce((a, s) => a + s.recall, 0) / list.length
  const answered = list.filter((s) => s.retrieved > 0)
  const precision = answered.reduce((a, s) => a + s.tp / s.retrieved, 0) / (answered.length || 1)
  const f1 = recall + precision === 0 ? 0 : (2 * recall * precision) / (recall + precision)
  const gain = list.reduce((a, s) => a + s.gain, 0) / list.length
  const retrieved = list.reduce((a, s) => a + s.retrieved, 0) / list.length
  return { n: list.length, empty: list.length - answered.length, recall, precision, f1, gain, retrieved }
}

const shownLemma = new Map([...lemmaText].map(([key, text]) => [key.split("\t")[0] as string, text]))

// ---- false merges: different lemmas, different folded forms, one stem
const tally = (stemOfForm: (form: string) => string) => {
  const byStem = new Map<string, Map<string, Map<string, { shown: string; count: number }>>>()
  for (const { form, key } of tokens) {
    const stem = stemOfForm(form)
    const lemma = key.split("\t")[0] as string
    const fs = held(
      held(byStem, stem, () => new Map()),
      lemma,
      () => new Map(),
    )
    const entry = fs.get(normalize(form)) ?? { shown: form, count: 0 }
    entry.count++
    fs.set(normalize(form), entry)
  }
  let classes = 0
  let merged = 0
  const examples: { weight: number; text: string }[] = []
  for (const [stem, lemmas] of byStem) {
    classes++
    if (lemmas.size < 2) continue
    merged++
    const top = [...lemmas]
      .map(([lemma, fs]) => {
        const { shown, count } = [...fs.values()].sort((a, b) => b.count - a.count)[0] as {
          shown: string
          count: number
        }
        return { lemma: shownLemma.get(lemma) ?? lemma, form: shown, count }
      })
      .sort((a, b) => b.count - a.count)
    const [a, b] = top as [(typeof top)[0], (typeof top)[0]]
    if (normalize(a.form) === normalize(b.form) || a.form.length > 8 || b.form.length > 8) continue
    examples.push({
      weight: Math.min(a.count, b.count),
      text: `\`${stem}\`: ${a.form} (${a.lemma}) + ${b.form} (${b.lemma})`,
    })
  }
  return { classes, merged, examples: examples.sort((x, y) => y.weight - x.weight).slice(0, 8) }
}

// ---- report
out(`## Quality — ${corpus.language}: ${corpus.label} [run]`)
out()
out(
  `- ${texts.length.toLocaleString("en")} sentences = messages; ${tokens.length.toLocaleString("en")} content tokens.`,
)
out(
  `- Tokenizer parity: fts5vocab holds ${ftsTerms.toLocaleString("en")} terms, the JS tokenizer ${jsTerms.size.toLocaleString("en")}.`,
)
out(
  `- Bands by document frequency (sentences holding the lemma), of ${eligible.length.toLocaleString("en")} eligible lemmas (content UPOS, ≥ 3 letters, an attested form other than the lemma): ${bandRanges.join("; ")}.`,
)
out(`- ${PER_BAND} lemmas per band (seed ${SEED}), each asked twice: as the lemma and as a random attested other form.`)
out()
out("| row | recall | precision | F1 | gain (relevant msgs/query vs Exact) | retrieved/query | empty answers |")
out("|---|---|---|---|---|---|---|")
for (const row of ROWS) {
  const s = summary(`${row.name}|all|all`)
  out(
    `| ${row.name} | ${fmt(s.recall)} | ${fmt(s.precision)} | ${fmt(s.f1)} | ${s.gain.toFixed(1)} | ${s.retrieved.toFixed(1)} | ${s.empty}/${s.n} |`,
  )
}
out()
out("By band × query type — recall / precision / F1 / gain:")
out()
const cells = [...BANDS.map((b) => b.band), "all"].flatMap((band) => ["lemma", "form"].map((kind) => ({ band, kind })))
out(`| row | ${cells.map((c) => `${c.band} ${c.kind}`).join(" | ")} |`)
out(`|---|${cells.map(() => "---|").join("")}`)
for (const row of ROWS) {
  out(
    `| ${row.name} | ${cells
      .map((c) => {
        const s = summary(`${row.name}|${c.band}|${c.kind}`)
        return `${fmt(s.recall, 2)} / ${fmt(s.precision, 2)} / ${fmt(s.f1, 2)} / ${s.gain.toFixed(1)}`
      })
      .join(" | ")} |`,
  )
}
out()
const merges = [
  { label: "no stemming (folded surface form)", fn: (f: string) => normalize(f) },
  { label: "Snowball by script (stem, then fold)", fn: (f: string) => stemQuery(f) },
  ...(latinReference
    ? [{ label: "English Snowball (reference)", fn: (f: string) => stemQuery(f, "stem-then-fold", "en") }]
    : []),
]
out("False merges over content tokens — classes (folded form or stem) that hold more than one lemma:")
out()
out("| key | classes | classes with >1 lemma | share |")
out("|---|---|---|---|")
const tallies = merges.map((m) => ({ ...m, t: tally(m.fn) }))
for (const { label, t } of tallies) {
  out(
    `| ${label} | ${t.classes.toLocaleString("en")} | ${t.merged.toLocaleString("en")} | ${((100 * t.merged) / t.classes).toFixed(1)}% |`,
  )
}
out()
out(
  `False-merge examples (stem: form (lemma) + form (lemma)), most frequent first: ${(tallies[1]?.t.examples ?? []).map((e) => e.text).join("; ")}.`,
)
out()
