// Cost of each index on the synthetic corpus of bench/search/gen.ts: build time, size on disk, query
// latency. Its words are random syllables, so the stems here measure cost only, never quality.
//
//   SEARCHBENCH_DATA=<dir with corpus-N.tsv> STEMBENCH_DB=<dir for the databases> node cost.ts N
import { execSync } from "node:child_process"
import { createReadStream, mkdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { DatabaseSync } from "node:sqlite"
import { editDistance, maxEdits, mulberry32, out, pctl, quoted, stemQuery, stemTokens, trigrams, words } from "./lib.ts"

const N = Number(process.argv[2])
const CORPUS_DIR = process.env.SEARCHBENCH_DATA
const DB_DIR = process.env.STEMBENCH_DB
if (!Number.isInteger(N) || !CORPUS_DIR || !DB_DIR)
  throw new Error("usage: SEARCHBENCH_DATA=… STEMBENCH_DB=… node cost.ts N")
const corpus = join(CORPUS_DIR, `corpus-${N}.tsv`)
const dir = join(DB_DIR, `stemming-${N}`)
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
const RUNS = 20
const WARM = 2
const LIMIT = 20

const rows = async function* () {
  const rl = createInterface({ input: createReadStream(corpus), crlfDelay: Infinity })
  for await (const line of rl) {
    const f = line.split("\t")
    yield { id: Number(f[0]), text: f[5] as string, normalized: f[6] as string }
  }
}
const open = (file: string) => {
  const db = new DatabaseSync(join(dir, file))
  db.exec("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA cache_size = -262144")
  return db
}
const size = (file: string) => statSync(join(dir, file)).size
const mb = (bytes: number) => `${(bytes / 1048576).toFixed(0)} MB`
const sec = (ms: number) => `${(ms / 1000).toFixed(2)} s`
const timed = async (fn: () => Promise<void> | void) => {
  const t = performance.now()
  await fn()
  return performance.now() - t
}
const fill = async (db: DatabaseSync, sql: string, value: (r: { text: string; normalized: string }) => string) => {
  const ins = db.prepare(sql)
  let n = 0
  db.exec("BEGIN")
  for await (const r of rows()) {
    ins.run(r.id, value(r))
    if (++n % 50_000 === 0) db.exec("COMMIT; BEGIN")
  }
  db.exec("COMMIT")
}
const optimize = (db: DatabaseSync, table: string) => db.exec(`INSERT INTO ${table} (${table}) VALUES ('optimize')`)

// ---- build
const wordsDb = open("words.db")
wordsDb.exec(`CREATE VIRTUAL TABLE message_words USING fts5(normalized_text, scope, content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2', prefix = '3');
CREATE VIRTUAL TABLE message_words_vocab USING fts5vocab(message_words, 'col');`)
const wordsBuild = await timed(async () => {
  await fill(
    wordsDb,
    "INSERT INTO message_words (rowid, normalized_text, scope) VALUES (?, ?, '')",
    (r) => r.normalized,
  )
  optimize(wordsDb, "message_words")
})
const wordsSize = size("words.db")
let terms = 0
const vocabBuild = await timed(() => {
  wordsDb.exec(`CREATE TABLE search_terms (term TEXT PRIMARY KEY, length INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE search_term_trigrams (trigram TEXT NOT NULL, length INTEGER NOT NULL, term TEXT NOT NULL,
  PRIMARY KEY (trigram, length, term)) WITHOUT ROWID;`)
  const term = wordsDb.prepare("INSERT OR IGNORE INTO search_terms (term, length) VALUES (?, ?)")
  const tri = wordsDb.prepare("INSERT OR IGNORE INTO search_term_trigrams (trigram, length, term) VALUES (?, ?, ?)")
  wordsDb.exec("BEGIN")
  for (const row of wordsDb.prepare("SELECT term FROM message_words_vocab WHERE col = 'normalized_text'").iterate()) {
    const word = String(row.term)
    terms++
    term.run(word, word.length)
    if (!/^\d+$/.test(word)) for (const piece of trigrams(word)) tri.run(piece, word.length, word)
  }
  wordsDb.exec("COMMIT")
})
const vocabSize = size("words.db") - wordsSize

const stemsDb = open("stems.db")
stemsDb.exec(
  "CREATE VIRTUAL TABLE message_stems USING fts5(stems, content = '', tokenize = 'unicode61 remove_diacritics 2')",
)
let stemming = 0
const stemsBuild = await timed(async () => {
  await fill(stemsDb, "INSERT INTO message_stems (rowid, stems) VALUES (?, ?)", (r) => {
    const t = performance.now()
    const stems = stemTokens(r.text).join(" ")
    stemming += performance.now() - t
    return stems
  })
  optimize(stemsDb, "message_stems")
})

const triDb = open("trigrams.db")
triDb.exec("CREATE VIRTUAL TABLE message_trigrams USING fts5(normalized_text, content = '', tokenize = 'trigram')")
const triBuild = await timed(async () => {
  await fill(triDb, "INSERT INTO message_trigrams (rowid, normalized_text) VALUES (?, ?)", (r) => r.normalized)
  optimize(triDb, "message_trigrams")
})

// ---- query words: two document-frequency bands, the original (accented) spelling found in the corpus
const vocab = wordsDb
  .prepare(
    "SELECT term, doc FROM message_words_vocab WHERE col = 'normalized_text' AND length(term) >= 4 AND term GLOB '*[^0-9]*'",
  )
  .all()
  .map((r) => ({ term: String(r.term), doc: Number(r.doc) }))
const rand = mulberry32(42)
const pick = (lo: number, hi: number) => {
  const pool = vocab.filter((v) => v.doc >= lo * N && v.doc <= hi * N)
  return Array.from({ length: RUNS + WARM }, () => (pool[Math.floor(rand() * pool.length)] as { term: string }).term)
}
const bands = [
  { label: "~1% df (0.3–3%)", words: pick(0.003, 0.03) },
  { label: "rare (0.01–0.1% df)", words: pick(0.0001, 0.001) },
]
const wanted = new Set(bands.flatMap((b) => b.words))
const original = new Map<string, string>()
for await (const r of rows()) {
  const raw =
    r.text
      .normalize("NFC")
      .toLowerCase()
      .match(/[\p{L}\p{N}\p{Co}\p{M}]+/gu) ?? []
  const folded = r.normalized.match(/[\p{L}\p{N}\p{Co}]+/gu) ?? []
  if (raw.length !== folded.length) continue
  folded.forEach((f, i) => {
    if (wanted.has(f) && !original.has(f)) original.set(f, raw[i] as string)
  })
  if (original.size === wanted.size) break
}

const context = { database: wordsDb }
const neighbours = (word: string) => {
  const max = maxEdits(word)
  return words
    .termCandidates(context, trigrams(word), { shortest: Math.max(3, word.length - max), longest: word.length + max })
    .filter((c) => c.term !== word && editDistance(word, c.term, max) <= max)
    .sort((a, b) => b.docs - a.docs)
    .slice(0, 5)
    .map((c) => c.term)
}
const ranked = (db: DatabaseSync, table: string) => {
  const stmt = db.prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH ? ORDER BY rank LIMIT ${LIMIT}`)
  return (expr: string) => stmt.all(expr).length
}
const exactQ = ranked(wordsDb, "message_words")
const stemQ = ranked(stemsDb, "message_stems")
const triQ = ranked(triDb, "message_trigrams")
const QUERIES: { row: string; run: (w: string) => number }[] = [
  { row: "Exact (today)", run: (w) => exactQ(quoted(w)) },
  { row: "S", run: (w) => stemQ(quoted(stemQuery(original.get(w) ?? w))) },
  { row: "T1 (correction + search)", run: (w) => exactQ([w, ...neighbours(w)].map(quoted).join(" OR ")) },
  { row: "T2", run: (w) => triQ(quoted(w)) },
]

const free = execSync("free -m | awk '/Mem:/ {print $7}'").toString().trim()
const storage = execSync(`df --output=fstype ${dir} | tail -1`).toString().trim()
out(`### N = ${N.toLocaleString("en")} [run]`)
out()
out(
  `- Databases on \`${storage}\`${storage === "tmpfs" ? " (RAM)" : " (disk, warm page cache)"}; ${free} MB available RAM at query time; node ${process.version}.`,
)
out(`- Peak RSS of this process ${(process.resourceUsage().maxRSS / 1024).toFixed(0)} MB.`)
out()
out("| index | build | disk | notes |")
out("|---|---|---|---|")
out(`| message_words (Exact, today) | ${sec(wordsBuild)} | ${mb(wordsSize)} | product DDL, optimize included |`)
out(
  `| T1 vocabulary (search_terms + trigrams, today) | ${sec(vocabBuild)} | ${mb(vocabSize)} | ${terms.toLocaleString("en")} terms |`,
)
out(`| S: message_stems | ${sec(stemsBuild)} | ${mb(size("stems.db"))} | of which Snowball in JS ${sec(stemming)} |`)
out(`| T2: message_trigrams (normalized, contentless) | ${sec(triBuild)} | ${mb(size("trigrams.db"))} | |`)
out()
out(`| query | words | p50 ms | p95 ms | avg rows (LIMIT ${LIMIT}) |`)
out("|---|---|---|---|---|")
for (const { label, words: list } of bands) {
  for (const { row, run } of QUERIES) {
    const times: number[] = []
    let rowsSeen = 0
    list.forEach((w, i) => {
      const t = performance.now()
      const n = run(w)
      const ms = performance.now() - t
      if (i >= WARM) {
        times.push(ms)
        rowsSeen += n
      }
    })
    out(
      `| ${row} | ${label} | ${pctl(times, 50).toFixed(2)} | ${pctl(times, 95).toFixed(2)} | ${(rowsSeen / RUNS).toFixed(1)} |`,
    )
  }
}
out()
for (const db of [wordsDb, stemsDb, triDb]) db.close()
rmSync(dir, { recursive: true, force: true })
