import { createReadStream, mkdirSync, existsSync } from "node:fs"
import { createInterface } from "node:readline"
import { join } from "node:path"
import {
  DATA_DIR,
  EXACT,
  FUZZY,
  RUNTIME,
  damerau,
  du,
  filters,
  fmt,
  loadMeta,
  maxEdits,
  maxRssMb,
  mb,
  normalize,
  out,
  pctl,
  pick,
  recall,
  tokens,
  trigrams,
  type Filter,
} from "./common.ts"

type Stmt = { all: (...a: any[]) => any[]; get: (...a: any[]) => any; run: (...a: any[]) => any }
type Db = { exec: (s: string) => void; prepare: (s: string) => Stmt; close: () => void }

async function openDb(path: string): Promise<Db> {
  if ((globalThis as any).Bun) {
    const { Database } = await import("bun:sqlite")
    const d = new Database(path)
    return {
      exec: (s) => d.exec(s),
      prepare: (s) => {
        const st = d.prepare(s)
        return { all: (...a) => st.all(...a), get: (...a) => st.get(...a) ?? undefined, run: (...a) => st.run(...a) }
      },
      close: () => d.close(),
    }
  }
  const { DatabaseSync } = await import("node:sqlite")
  const d = new DatabaseSync(path)
  return { exec: (s) => d.exec(s), prepare: (s) => d.prepare(s) as any, close: () => d.close() }
}

const [phase, nArg, variant = "after"] = process.argv.slice(2)
const N = Number(nArg)
const tag = (globalThis as any).Bun ? "bun" : "node"
const dir = join(DATA_DIR, `sqlite-${N}-${tag}-${variant}`)
const file = join(dir, "db.sqlite")
const sec = (ms: number) => `${(ms / 1000).toFixed(2)} s`

const SCHEMA = `
CREATE TABLE messages (
  id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL, sender_id INTEGER NOT NULL, source TEXT NOT NULL,
  sent_at INTEGER NOT NULL, text TEXT NOT NULL, normalized_text TEXT NOT NULL);
CREATE VIRTUAL TABLE messages_fts USING fts5(normalized_text, content='messages', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2');
`

async function build() {
  if (existsSync(dir)) throw new Error(`${dir} exists`)
  mkdirSync(dir, { recursive: true })
  const db = await openDb(file)
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF; PRAGMA cache_size=-262144; PRAGMA temp_store=MEMORY")
  db.exec(SCHEMA)
  const ins = db.prepare("INSERT INTO messages VALUES (?,?,?,?,?,?,?)")
  const insFts =
    variant === "inline" ? db.prepare("INSERT INTO messages_fts(rowid, normalized_text) VALUES (?,?)") : null
  const t0 = performance.now()
  let rows = 0
  db.exec("BEGIN")
  const rl = createInterface({ input: createReadStream(join(DATA_DIR, `corpus-${N}.tsv`)), crlfDelay: Infinity })
  for await (const line of rl) {
    const f = line.split("\t")
    ins.run(Number(f[0]), Number(f[1]), Number(f[2]), f[3], Number(f[4]), f[5], f[6])
    insFts?.run(Number(f[0]), f[6])
    if (++rows % 50_000 === 0) db.exec("COMMIT; BEGIN")
  }
  db.exec("COMMIT")
  const load = performance.now() - t0

  const step = (sql: string) => {
    const t = performance.now()
    db.exec(sql)
    return performance.now() - t
  }
  const ftsRebuild = variant === "inline" ? 0 : step("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')")
  const ftsOptimize = step("INSERT INTO messages_fts(messages_fts) VALUES('optimize')")
  const btree = step(`CREATE INDEX messages_chat_sent ON messages(chat_id, sent_at);
    CREATE INDEX messages_sender ON messages(sender_id); CREATE INDEX messages_source ON messages(source);`)

  const tv = performance.now()
  db.exec(`CREATE VIRTUAL TABLE fts_vocab USING fts5vocab(messages_fts, row);
    CREATE TABLE vocab (id INTEGER PRIMARY KEY, term TEXT NOT NULL UNIQUE, doc INTEGER NOT NULL);
    INSERT INTO vocab(term, doc) SELECT term, doc FROM fts_vocab;
    CREATE TABLE vocab_tri (tri TEXT NOT NULL, len INTEGER NOT NULL, term_id INTEGER NOT NULL,
      PRIMARY KEY (tri, len, term_id)) WITHOUT ROWID;`)
  const vocabRows = db.prepare("SELECT id, term FROM vocab").all()
  const triRows: [string, number, number][] = []
  for (const v of vocabRows) {
    if (/^\d+$/.test(v.term)) continue
    for (const t of trigrams(v.term)) triRows.push([t, v.term.length, v.id])
  }
  triRows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1] || a[2] - b[2]))
  const insTri = db.prepare("INSERT INTO vocab_tri VALUES (?,?,?)")
  db.exec("BEGIN")
  for (const r of triRows) insTri.run(r[0], r[1], r[2])
  db.exec("COMMIT")
  const vocabMs = performance.now() - tv

  db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  const size = du(dir)
  db.close()
  out(
    `| sqlite | ${RUNTIME} | ${N.toLocaleString("en")} | ${variant} | ${Math.round(N / (load / 1000)).toLocaleString("en")} rows/s (${sec(load)}) | ` +
      `FTS rebuild ${sec(ftsRebuild)} + optimize ${sec(ftsOptimize)}; btree ${sec(btree)}; vocab+trigram ${sec(vocabMs)} (${vocabRows.length.toLocaleString("en")} terms, ${triRows.length.toLocaleString("en")} trigram rows) | ` +
      `${mb(size)} | ${maxRssMb()} MB |`,
  )
}

function whereFor(f: Filter): { sql: string; args: any[] } {
  const parts: string[] = []
  const args: any[] = []
  if (f.chat !== undefined) parts.push("m.chat_id = ?"), args.push(f.chat)
  if (f.sender !== undefined) parts.push("m.sender_id = ?"), args.push(f.sender)
  if (f.from !== undefined) parts.push("m.sent_at BETWEEN ? AND ?"), args.push(f.from, f.to)
  return { sql: parts.map((p) => ` AND ${p}`).join(""), args }
}

const quote = (t: string) => `"${t.replace(/"/g, '""')}"`

async function query() {
  const tOpen = performance.now()
  const db = await openDb(file)
  db.exec("PRAGMA cache_size=-65536")
  const openMs = performance.now() - tOpen
  const searchSql = (f: Filter, limit: boolean) =>
    `SELECT m.id, bm25(messages_fts) AS score FROM messages_fts CROSS JOIN messages m ON m.id = messages_fts.rowid
     WHERE messages_fts MATCH ?${whereFor(f).sql} ORDER BY score${limit ? " LIMIT 20" : ""}`
  const stmtCache = new Map<string, Stmt>()
  const stmt = (sql: string) => stmtCache.get(sql) ?? (stmtCache.set(sql, db.prepare(sql)), stmtCache.get(sql)!)
  const search = (match: string, f: Filter, limit = true) => stmt(searchSql(f, limit)).all(match, ...whereFor(f).args)

  search(quote("hola"), { label: "all" })
  const firstMs = performance.now()
  const { meta, truth } = loadMeta(N)
  out(
    `**sqlite ${RUNTIME} ${N.toLocaleString("en")}** — open ${fmt(openMs)} ms; process start → first search answered ${fmt(firstMs)} ms`,
  )
  out("")
  out("| engine | N | query | p50 ms | p95 ms | notes |")
  out("|---|---|---|---|---|---|")

  const rows: string[] = []
  const row = (label: string, samples: number[], note: string) => {
    const r = `| sqlite ${RUNTIME} | ${N.toLocaleString("en")} | ${label} | ${fmt(pctl(samples, 50))} | ${fmt(pctl(samples, 95))} | ${note} |`
    rows.push(r)
    out(r)
  }
  const time = (fn: (i: number) => any[]) => {
    fn(0), fn(1)
    const samples: number[] = []
    let hits = 0
    for (let i = 0; i < 20; i++) {
      const t = performance.now()
      hits += fn(i).length
      samples.push(performance.now() - t)
    }
    return { samples, avgHits: (hits / 20).toFixed(1) }
  }

  const classes: [string, string[][]][] = [
    ["2 words ~1% df", meta.queries.typical],
    ["2 words 5–15% df", meta.queries.common],
  ]
  for (const [cls, sets] of classes) {
    for (const f of filters(meta)) {
      const { samples, avgHits } = time((i) => search(sets[i].map(quote).join(" "), f))
      row(`BM25 AND ${cls} — ${f.label}`, samples, `avg rows ${avgHits}`)
      const or = time((i) => search(sets[i].map(quote).join(" OR "), f))
      row(`BM25 OR ${cls} — ${f.label}`, or.samples, `avg rows ${or.avgHits}`)
    }
  }
  {
    const { samples, avgHits } = time((i) => search(meta.queries.three[i].map(quote).join(" "), { label: "all" }))
    row("BM25 AND 3 words — all", samples, `avg rows ${avgHits}`)
    const r2 = time((i) => search(meta.queries.three[i].map(quote).join(" OR "), { label: "all" }))
    row("BM25 OR 3 words — all", r2.samples, `avg rows ${r2.avgHits}`)
  }

  const vocabGet = db.prepare("SELECT doc FROM vocab WHERE term = ?")
  const triSql = (k: number) =>
    `SELECT v.term, v.doc, count(*) AS c FROM vocab_tri t JOIN vocab v ON v.id = t.term_id
     WHERE t.tri IN (${Array(k).fill("?").join(",")}) AND t.len BETWEEN ? AND ?
     GROUP BY t.term_id ORDER BY c DESC LIMIT 50`
  const correct = (q: string) => {
    const groups: string[][] = []
    for (const term of tokens(normalize(q))) {
      if (vocabGet.get(term)) {
        groups.push([term])
        continue
      }
      const tris = trigrams(term)
      const max = maxEdits(term)
      const cands = stmt(triSql(tris.length))
        .all(...tris, term.length - max, term.length + max)
        .map((c: any) => ({ term: c.term as string, df: c.doc as number, dist: damerau(term, c.term, max) }))
        .filter((c) => c.dist <= max)
      const chosen = pick(cands)
      groups.push(chosen.length ? chosen.map((c) => c.term) : [term])
    }
    return groups
  }
  const matchOf = (groups: string[][]) => groups.map((g) => `(${g.map(quote).join(" OR ")})`).join(" ")

  const recallRows: string[] = []
  for (const fz of FUZZY) {
    const { samples } = time(() => search(matchOf(correct(fz.query)), { label: "all" }))
    const tc = []
    for (let i = 0; i < 20; i++) {
      const t = performance.now()
      correct(fz.query)
      tc.push(performance.now() - t)
    }
    const groups = correct(fz.query)
    const all = search(matchOf(groups), { label: "all" }, false).map((r: any) => r.id as number)
    const rc = recall(all, truth[fz.truthKey])
    row(
      `fuzzy "${fz.query}" (correction + search)`,
      samples,
      `correction alone p50 ${fmt(pctl(tc, 50))} / p95 ${fmt(pctl(tc, 95))} ms → ${groups.map((g) => g.join("|")).join(" ")}`,
    )
    const rr = `| sqlite ${RUNTIME} | ${N.toLocaleString("en")} | "${fz.query}" | ${groups.map((g) => g.join("|")).join(" ")} | ${truth[fz.truthKey].length} | ${rc.n} | ${(rc.recall * 100).toFixed(1)}% | ${(rc.precision * 100).toFixed(1)}% |`
    recallRows.push(rr)
  }
  for (const ex of EXACT) {
    const m = tokens(normalize(ex.query)).map(quote).join(" ")
    const { samples } = time(() => search(m, { label: "all" }))
    const rc = recall(
      search(m, { label: "all" }, false).map((r: any) => r.id),
      truth[ex.truthKey],
    )
    row(ex.label, samples, `recall ${(rc.recall * 100).toFixed(1)}% of ${truth[ex.truthKey].length}`)
  }
  out("")
  out(`Fuzzy recall — sqlite ${RUNTIME} ${N.toLocaleString("en")}`)
  out("")
  out("| engine | N | typo | corrected to | truth msgs | returned | recall | precision |")
  out("|---|---|---|---|---|---|---|---|")
  for (const r of recallRows) out(r)
  out("")

  if (process.env.PLANS) {
    out("```")
    for (const f of filters(meta)) {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${searchSql(f, true)}`).all('"hola"', ...whereFor(f).args)
      out(`-- ${f.label}: ${plan.map((p: any) => p.detail).join(" / ")}`)
    }
    const tris = trigrams("valenca")
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${triSql(tris.length)}`).all(...tris, 5, 9)
    out(`-- trigram candidates: ${plan.map((p: any) => p.detail).join(" / ")}`)
    out("```")
  }
  out(`sqlite ${RUNTIME} ${N} query-process peak RSS ${maxRssMb()} MB`)
  out("")
  db.close()
}

if (phase === "build") await build()
else if (phase === "query") await query()
else throw new Error("usage: sqlite.ts build|query N [after|inline]")
