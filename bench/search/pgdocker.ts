import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import pg from "pg"
import { DATA_DIR, RUNTIME, du, fmt, mb, out } from "./common.ts"
import { SCHEMA, buildIndexes, runQueries, type Pg } from "./pgcore.ts"

const [phase, nArg] = process.argv.slice(2)
const N = Number(nArg)
const sec = (ms: number) => `${(ms / 1000).toFixed(2)} s`
const cid = readFileSync(join(DATA_DIR, `pgdocker-${N}.cid`), "utf8").trim()
const cgroupPeak = () => {
  const v = execFileSync("docker", ["exec", cid, "cat", "/sys/fs/cgroup/memory.peak"], { encoding: "utf8" })
  return `${Math.round(Number(v) / 1024 / 1024)} MB`
}

const tStart = performance.now()
const client = new pg.Client({
  host: "127.0.0.1",
  port: 55432,
  user: "postgres",
  password: "bench",
  database: "postgres",
})
await client.connect()
const db: Pg = { query: (s, p) => client.query(s, p), exec: (s) => client.query(s) }
const engine = "postgres 18.6 docker"

if (phase === "build") {
  await db.exec(SCHEMA)
  const t0 = performance.now()
  await db.exec(`COPY messages FROM '/data/corpus-${N}.tsv'`)
  const load = performance.now() - t0
  const { summary } = await buildIndexes(db, sec)
  await db.exec("CHECKPOINT")
  const ver = (await db.query("SELECT extversion FROM pg_extension WHERE extname = 'pg_textsearch'")).rows[0].extversion
  out(
    `| ${engine} (pg_textsearch ${ver}) | ${RUNTIME} client | ${N.toLocaleString("en")} | server-side COPY | ${Math.round(N / (load / 1000)).toLocaleString("en")} rows/s (${sec(load)}) | ${summary} | ${mb(du(join(DATA_DIR, `pgdocker-${N}`)))} | ${cgroupPeak()} (container cgroup peak, incl. page cache) |`,
  )
} else if (phase === "query") {
  const openMs = performance.now() - tStart
  await db.query("SELECT id FROM messages ORDER BY normalized_text <@> to_bm25query('hola', 'messages_bm25') LIMIT 20")
  out(
    `**${engine} ${N.toLocaleString("en")}** — connect ${fmt(openMs)} ms, first search answered ${fmt(performance.now())} ms after process start (server restarted just before)`,
  )
  await runQueries(db, engine, N)
  out(`${engine} ${N} container cgroup peak ${cgroupPeak()}`)
  out("")
}
await client.end()
