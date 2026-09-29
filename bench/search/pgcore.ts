import {
  EXACT,
  FUZZY,
  damerau,
  filters,
  fmt,
  loadMeta,
  maxEdits,
  normalize,
  out,
  pctl,
  pick,
  recall,
  tokens,
  type Filter,
} from "./common.ts"

export type Pg = {
  query: (sql: string, params?: any[]) => Promise<{ rows: any[] }>
  exec: (sql: string) => Promise<unknown>
}

export const SCHEMA = `
CREATE EXTENSION IF NOT EXISTS pg_textsearch;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE TABLE messages (
  id bigint NOT NULL, chat_id int NOT NULL, sender_id int NOT NULL, source text NOT NULL,
  sent_at bigint NOT NULL, text text NOT NULL, normalized_text text NOT NULL);
`

export async function buildIndexes(
  pg: Pg,
  sec: (ms: number) => string,
): Promise<{ summary: string; bm25Failed: boolean }> {
  const step = async (sql: string) => {
    const t = performance.now()
    await pg.exec(sql)
    return performance.now() - t
  }
  await pg.exec("SET maintenance_work_mem = '256MB'")
  const btree = await step(`ALTER TABLE messages ADD PRIMARY KEY (id);
    CREATE INDEX messages_chat_sent ON messages(chat_id, sent_at);
    CREATE INDEX messages_sender ON messages(sender_id);
    CREATE INDEX messages_source ON messages(source);`)
  let bm25Failed = false
  let bm25 = 0
  try {
    bm25 = await step("CREATE INDEX messages_bm25 ON messages USING bm25(normalized_text) WITH (text_config='simple')")
  } catch (e) {
    bm25Failed = true
    out(`pg_textsearch index failed: ${(e as Error).message}; falling back to ts_rank_cd over a GIN tsvector`)
    bm25 = await step("CREATE INDEX messages_tsv ON messages USING gin (to_tsvector('simple', normalized_text))")
  }
  const vocab = await step(`CREATE TABLE vocab AS
      SELECT word AS term, ndoc AS doc FROM ts_stat('SELECT to_tsvector(''simple'', normalized_text) FROM messages');
    CREATE INDEX vocab_term ON vocab(term);`)
  const trgm = await step("CREATE INDEX vocab_trgm ON vocab USING gin (term gin_trgm_ops)")
  const vacuum = await step("VACUUM ANALYZE")
  const terms = (await pg.query("SELECT count(*)::int AS n FROM vocab")).rows[0].n
  return {
    bm25Failed,
    summary:
      `btree+PK ${sec(btree)}; ${bm25Failed ? "GIN tsvector (fallback)" : "BM25"} ${sec(bm25)}; ` +
      `vocab via ts_stat ${sec(vocab)} (${terms.toLocaleString("en")} terms); pg_trgm GIN ${sec(trgm)}; VACUUM ANALYZE ${sec(vacuum)}`,
  }
}

function whereFor(f: Filter, first: number): { sql: string; args: any[] } {
  const parts: string[] = []
  const args: any[] = []
  let i = first
  if (f.chat !== undefined) parts.push(`chat_id = $${i++}`), args.push(f.chat)
  if (f.sender !== undefined) parts.push(`sender_id = $${i++}`), args.push(f.sender)
  if (f.from !== undefined) parts.push(`sent_at BETWEEN $${i++} AND $${i++}`), args.push(f.from, f.to)
  return { sql: parts.length ? ` WHERE ${parts.join(" AND ")}` : "", args }
}

export async function runQueries(pg: Pg, engine: string, n: number) {
  const { meta, truth } = loadMeta(n)
  const N = n.toLocaleString("en")
  const bm25 = (await pg.query("SELECT 1 FROM pg_class WHERE relname = 'messages_bm25'")).rows.length > 0
  const searchSql = (f: Filter, limit: boolean) => {
    const w = whereFor(f, 2)
    const ranked = (lim: number) =>
      `SELECT id, normalized_text <@> to_bm25query($1, 'messages_bm25') AS score FROM messages${w.sql} ORDER BY score LIMIT ${lim}`
    // When a btree pre-filters the rows, pg_textsearch 1.3.1 (PGlite) scores every one and returns
    // non-matches with score 0; the outer filter drops them. It also lets recall read without a LIMIT.
    return bm25
      ? `SELECT * FROM (${ranked(limit ? 20 : 100_000)}) s WHERE score < 0`
      : `SELECT id, ts_rank_cd(to_tsvector('simple', normalized_text), q) AS score
         FROM messages, to_tsquery('simple', $1) q
         ${w.sql ? `${w.sql} AND` : "WHERE"} to_tsvector('simple', normalized_text) @@ q ORDER BY score DESC${limit ? " LIMIT 20" : ""}`
  }
  const text = (terms: string[]) => (bm25 ? terms.join(" ") : terms.join(" | "))
  const search = async (terms: string[], f: Filter, limit = true) =>
    (await pg.query(searchSql(f, limit), [text(terms), ...whereFor(f, 2).args])).rows
  const truthCount = async (terms: string[], f: Filter) => {
    const w = whereFor(f, 2)
    const sql = `SELECT count(*)::int AS n FROM (SELECT 1 FROM messages${w.sql ? `${w.sql} AND` : " WHERE"}
      to_tsvector('simple', normalized_text) @@ to_tsquery('simple', $1) LIMIT 20) s`
    return (await pg.query(sql, [terms.join(" | "), ...w.args])).rows[0].n as number
  }

  const row = (label: string, samples: number[], note: string) =>
    out(`| ${engine} | ${N} | ${label} | ${fmt(pctl(samples, 50))} | ${fmt(pctl(samples, 95))} | ${note} |`)
  const time = async (fn: (i: number) => Promise<any[]>) => {
    await fn(0)
    await fn(1)
    const samples: number[] = []
    const counts: number[] = []
    for (let i = 0; i < 20; i++) {
      const t = performance.now()
      counts.push((await fn(i)).length)
      samples.push(performance.now() - t)
    }
    return { samples, counts, avgHits: (counts.reduce((a, b) => a + b, 0) / 20).toFixed(1) }
  }

  out("")
  out("| engine | N | query | p50 ms | p95 ms | notes |")
  out("|---|---|---|---|---|---|")
  const classes: [string, string[][]][] = [
    ["2 words ~1% df", meta.queries.typical],
    ["2 words 5–15% df", meta.queries.common],
  ]
  for (const [cls, sets] of classes) {
    for (const f of filters(meta)) {
      const r = await time((i) => search(sets[i], f))
      let short = 0
      for (let i = 0; i < 20; i++) if (r.counts[i] < 20 && (await truthCount(sets[i], f)) > r.counts[i]) short++
      row(
        `BM25 OR ${cls} — ${f.label}`,
        r.samples,
        `avg rows ${r.avgHits}${short ? `; **${short}/20 returned fewer rows than exist**` : ""}`,
      )
    }
  }
  {
    const r = await time((i) => search(meta.queries.three[i], { label: "all" }))
    row("BM25 OR 3 words — all", r.samples, `avg rows ${r.avgHits}`)
  }

  const correct = async (q: string) => {
    const groups: string[][] = []
    for (const term of tokens(normalize(q))) {
      if ((await pg.query("SELECT doc FROM vocab WHERE term = $1", [term])).rows.length) {
        groups.push([term])
        continue
      }
      const max = maxEdits(term)
      const cands = (
        await pg.query(
          `SELECT term, doc FROM vocab WHERE term % $1 AND length(term) BETWEEN $2 AND $3
           ORDER BY similarity(term, $1) DESC LIMIT 50`,
          [term, term.length - max, term.length + max],
        )
      ).rows
        .map((c: any) => ({ term: c.term as string, df: Number(c.doc), dist: damerau(term, c.term, max) }))
        .filter((c) => c.dist <= max)
      const chosen = pick(cands)
      groups.push(chosen.length ? chosen.map((c) => c.term) : [term])
    }
    return groups
  }

  const recallRows: string[] = []
  for (const fz of FUZZY) {
    const r = await time(async () => search((await correct(fz.query)).flat(), { label: "all" }))
    const tc: number[] = []
    for (let i = 0; i < 20; i++) {
      const t = performance.now()
      await correct(fz.query)
      tc.push(performance.now() - t)
    }
    const groups = await correct(fz.query)
    const all = (await search(groups.flat(), { label: "all" }, false)).map((x: any) => Number(x.id))
    const rc = recall(all, truth[fz.truthKey])
    const shown = groups.map((g) => g.join("|")).join(" ")
    row(
      `fuzzy "${fz.query}" (correction + search)`,
      r.samples,
      `correction alone p50 ${fmt(pctl(tc, 50))} / p95 ${fmt(pctl(tc, 95))} ms → ${shown}`,
    )
    recallRows.push(
      `| ${engine} | ${N} | "${fz.query}" | ${shown} | ${truth[fz.truthKey].length} | ${rc.n} | ${(rc.recall * 100).toFixed(1)}% | ${(rc.precision * 100).toFixed(1)}% |`,
    )
  }
  for (const ex of EXACT) {
    const terms = tokens(normalize(ex.query))
    const r = await time(() => search(terms, { label: "all" }))
    const rc = recall(
      (await search(terms, { label: "all" }, false)).map((x: any) => Number(x.id)),
      truth[ex.truthKey],
    )
    row(ex.label, r.samples, `recall ${(rc.recall * 100).toFixed(1)}% of ${truth[ex.truthKey].length}`)
  }
  out("")
  out(`Fuzzy recall — ${engine} ${N}`)
  out("")
  out("| engine | N | typo | corrected to | truth msgs | returned | recall | precision |")
  out("|---|---|---|---|---|---|---|---|")
  for (const r of recallRows) out(r)
  out("")

  if (process.env.PLANS) {
    out("```")
    for (const [cls, sets] of classes) {
      for (const f of filters(meta)) {
        const plan = (
          await pg.query(`EXPLAIN (ANALYZE, BUFFERS OFF) ${searchSql(f, true)}`, [
            text(sets[0]),
            ...whereFor(f, 2).args,
          ])
        ).rows.map((r: any) => r["QUERY PLAN"] as string)
        const nodes = plan
          .filter((l) => /Scan|Sort|Limit|Execution Time/.test(l))
          .map((l) =>
            l
              .trim()
              .replace(/\s+\(cost=[^)]*\)/, "")
              .replace(/^->\s*/, ""),
          )
        out(`-- ${cls} / ${f.label}: ${nodes.join(" / ")}`)
      }
    }
    const plan = (
      await pg.query(
        "EXPLAIN (ANALYZE, BUFFERS OFF) SELECT term, doc FROM vocab WHERE term % $1 AND length(term) BETWEEN $2 AND $3 ORDER BY similarity(term, $1) DESC LIMIT 50",
        ["valenca", 5, 9],
      )
    ).rows.map((r: any) => (r["QUERY PLAN"] as string).trim())
    out(`-- trigram candidates: ${plan.filter((l) => /Scan|Execution Time|Rows Removed/.test(l)).join(" / ")}`)
    out("```")
  }
}
