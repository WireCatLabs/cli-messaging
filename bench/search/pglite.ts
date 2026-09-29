import { createReadStream, existsSync } from "node:fs"
import { createInterface } from "node:readline"
import { join } from "node:path"
import { PGlite } from "@electric-sql/pglite"
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm"
import { unaccent } from "@electric-sql/pglite/contrib/unaccent"
import { pg_textsearch } from "@electric-sql/pglite-pg_textsearch"
import { DATA_DIR, RUNTIME, du, fmt, maxRssMb, mb, out } from "./common.ts"
import { SCHEMA, buildIndexes, runQueries } from "./pgcore.ts"

const [phase, nArg] = process.argv.slice(2)
const N = Number(nArg)
const tag = (globalThis as any).Bun ? "bun" : "node"
const dir = join(DATA_DIR, `pglite-${N}-${tag}`)
const sec = (ms: number) => `${(ms / 1000).toFixed(2)} s`
const extensions = { pg_trgm, unaccent, pg_textsearch }

async function build() {
  if (existsSync(dir)) throw new Error(`${dir} exists`)
  const pg = await PGlite.create(dir, { extensions })
  await pg.exec(SCHEMA)
  const t0 = performance.now()
  let chunk: string[] = []
  const flush = async () => {
    if (!chunk.length) return
    await pg.query("COPY messages FROM '/dev/blob'", [], { blob: new Blob([chunk.join("\n") + "\n"]) })
    chunk = []
  }
  const rl = createInterface({ input: createReadStream(join(DATA_DIR, `corpus-${N}.tsv`)), crlfDelay: Infinity })
  for await (const line of rl) {
    chunk.push(line)
    if (chunk.length === 100_000) await flush()
  }
  await flush()
  const load = performance.now() - t0
  const { summary } = await buildIndexes(pg, sec)
  await pg.exec("CHECKPOINT")
  await pg.close()
  out(
    `| pglite | ${RUNTIME} | ${N.toLocaleString("en")} | COPY /dev/blob, 100k-row chunks | ${Math.round(N / (load / 1000)).toLocaleString("en")} rows/s (${sec(load)}) | ${summary} | ${mb(du(dir))} | ${maxRssMb()} MB |`,
  )
}

async function query() {
  const tStart = performance.now()
  const pg = await PGlite.create(dir, { extensions })
  const openMs = performance.now() - tStart
  await pg.query("SELECT id FROM messages ORDER BY normalized_text <@> to_bm25query('hola', 'messages_bm25') LIMIT 20")
  out(
    `**pglite ${RUNTIME} ${N.toLocaleString("en")}** — open ${fmt(openMs)} ms; process start → first search answered ${fmt(performance.now())} ms`,
  )
  await runQueries(pg, `pglite ${RUNTIME}`, N)
  out(`pglite ${RUNTIME} ${N} query-process peak RSS ${maxRssMb()} MB`)
  out("")
  await pg.close()
}

if (phase === "build") await build()
else if (phase === "query") await query()
else throw new Error("usage: pglite.ts build|query N")
