// usage: <runtime> bench.mjs <insert|query|vec0> <N> <dims> <f32|i8> <dbfile>
const [phase, nArg, dArg, kind, file] = process.argv.slice(2)
const N = Number(nArg)
const D = Number(dArg)
const isBun = "Bun" in globalThis

const open = async (path, extensions = false) => {
  if (isBun) {
    const { Database } = await import("bun:sqlite")
    const db = new Database(path)
    return { exec: (s) => db.exec(s), prepare: (s) => db.query(s), raw: db, close: () => db.close() }
  }
  const { DatabaseSync } = await import("node:sqlite")
  const db = new DatabaseSync(path, { allowExtension: extensions })
  return { exec: (s) => db.exec(s), prepare: (s) => db.prepare(s), raw: db, close: () => db.close() }
}

let seed = 42
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 4294967296
}
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand())
const unitVector = () => {
  const v = new Float32Array(D)
  let s = 0
  for (let i = 0; i < D; i++) s += (v[i] = gauss()) ** 2
  s = Math.sqrt(s)
  for (let i = 0; i < D; i++) v[i] /= s
  return v
}
// Unit vectors have components well under 1; scale so the largest typical value uses the int8 range.
const SCALE = 127 / (4 / Math.sqrt(D))
const quantize = (v) => {
  const q = new Int8Array(D)
  for (let i = 0; i < D; i++) q[i] = Math.max(-127, Math.min(127, Math.round(v[i] * SCALE)))
  return q
}
const bytes = (v) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
const rssMB = () => Math.round(process.resourceUsage().maxRSS / 1024)
const ms = (t) => +(performance.now() - t).toFixed(1)

const topK = (k) => {
  const ids = new Array(k).fill(-1)
  const scores = new Float64Array(k).fill(-Infinity)
  return {
    push(id, s) {
      if (s <= scores[k - 1]) return
      let i = k - 1
      while (i > 0 && scores[i - 1] < s) {
        scores[i] = scores[i - 1]
        ids[i] = ids[i - 1]
        i--
      }
      scores[i] = s
      ids[i] = id
    },
    ids,
    scores,
  }
}

const out = (o) => console.log(JSON.stringify({ rt: isBun ? `bun ${Bun.version}` : `node ${process.version}`, phase, N, D, kind, ...o }))

if (phase === "insert") {
  const db = await open(file)
  db.exec(`PRAGMA journal_mode=${process.env.JM ?? "WAL"}; CREATE TABLE chunks(id INTEGER PRIMARY KEY, v BLOB NOT NULL)`)
  const st = db.prepare("INSERT INTO chunks(id, v) VALUES (?, ?)")
  let gen = 0
  const t = performance.now()
  db.exec("BEGIN")
  for (let i = 1; i <= N; i++) {
    const g = performance.now()
    const v = unitVector()
    const b = bytes(kind === "i8" ? quantize(v) : v)
    gen += performance.now() - g
    st.run(i, b)
  }
  db.exec("COMMIT")
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  const total = ms(t)
  db.close()
  const { statSync } = await import("node:fs")
  out({ insertMs: +(total - gen).toFixed(0), genMs: +gen.toFixed(0), fileMB: +(statSync(file).size / 2 ** 20).toFixed(1), rssMB: rssMB() })
}

if (phase === "query") {
  seed = 7
  const qf = unitVector()
  const qi = quantize(qf)
  const db = await open(file)
  const st = db.prepare("SELECT id, v FROM chunks")
  const dot = kind === "i8"
    ? (b, o) => {
        let s = 0
        for (let i = 0; i < D; i++) s += b[o + i] * qi[i]
        return s
      }
    : (b, o) => {
        let s = 0
        for (let i = 0; i < D; i++) s += b[o + i] * qf[i]
        return s
      }
  const view = (u8) => (kind === "i8"
    ? new Int8Array(u8.buffer, u8.byteOffset, D)
    : new Float32Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)))

  let t = performance.now()
  let top = topK(10)
  for (const row of st.iterate()) top.push(row.id, dot(view(row.v), 0))
  const coldMs = ms(t)
  const coldTop = top.ids.slice(0, 3)
  const rssCold = rssMB()

  t = performance.now()
  const all = kind === "i8" ? new Int8Array(N * D) : new Float32Array(N * D)
  const ids = new Int32Array(N)
  let r = 0
  for (const row of st.iterate()) {
    ids[r] = row.id
    all.set(kind === "i8" ? new Int8Array(row.v.buffer, row.v.byteOffset, D) : new Float32Array(row.v.buffer.slice(row.v.byteOffset, row.v.byteOffset + row.v.byteLength)), r * D)
    r++
  }
  const loadMs = ms(t)

  const runs = []
  for (let q = 0; q < 5; q++) {
    t = performance.now()
    top = topK(10)
    for (let j = 0; j < N; j++) top.push(ids[j], dot(all, j * D))
    runs.push(performance.now() - t)
  }
  runs.sort((a, b) => a - b)
  out({ coldMs, loadMs, warmMs: +runs[2].toFixed(1), rssColdMB: rssCold, rssWarmMB: rssMB(), same: coldTop.join() === top.ids.slice(0, 3).join(), top: top.ids.slice(0, 3) })
  db.close()
}

if (phase === "vec0") {
  const db = await open(file, true)
  const { getLoadablePath } = await import("sqlite-vec")
  db.raw.loadExtension(getLoadablePath())
  const col = kind === "i8" ? `int8[${D}]` : `float[${D}]`
  db.exec(`PRAGMA journal_mode=${process.env.JM ?? "WAL"}; CREATE VIRTUAL TABLE v USING vec0(e ${col} distance_metric=cosine)`)
  const ins = db.prepare(kind === "i8" ? "INSERT INTO v(rowid, e) VALUES (?, vec_int8(?))" : "INSERT INTO v(rowid, e) VALUES (?, ?)")
  let gen = 0
  let t = performance.now()
  db.exec("BEGIN")
  for (let i = 1; i <= N; i++) {
    const g = performance.now()
    const vv = unitVector()
    const b = bytes(kind === "i8" ? quantize(vv) : vv)
    gen += performance.now() - g
    ins.run(isBun ? i : BigInt(i), b)
  }
  db.exec("COMMIT")
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  const insertMs = +(ms(t) - gen).toFixed(0)
  db.close()
  const { statSync } = await import("node:fs")
  const fileMB = +(statSync(file).size / 2 ** 20).toFixed(1)

  seed = 7
  const qf = unitVector()
  const db2 = await open(file, true)
  db2.raw.loadExtension(getLoadablePath())
  const q = db2.prepare(kind === "i8"
    ? "SELECT rowid, distance FROM v WHERE e MATCH vec_int8(?) AND k = 10"
    : "SELECT rowid, distance FROM v WHERE e MATCH ? AND k = 10")
  const qb = bytes(kind === "i8" ? quantize(qf) : qf)
  t = performance.now()
  const first = q.all(qb)
  const coldMs = ms(t)
  const runs = []
  for (let i = 0; i < 5; i++) {
    t = performance.now()
    q.all(qb)
    runs.push(performance.now() - t)
  }
  runs.sort((a, b) => a - b)
  out({ insertMs, fileMB, coldMs, warmMs: +runs[2].toFixed(1), rssMB: rssMB(), top: first.slice(0, 3).map((x) => x.rowid) })
  db2.close()
}
