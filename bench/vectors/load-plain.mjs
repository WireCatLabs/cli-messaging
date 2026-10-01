import { DatabaseSync } from "node:sqlite"
const db = new DatabaseSync(":memory:", { allowExtension: true })
console.log("node", process.version, "sqlite", db.prepare("select sqlite_version() v").get().v)
for (const p of process.argv.slice(2)) {
  try {
    db.loadExtension(p)
    db.exec("create virtual table t using vec0(e float[4])")
    db.prepare("insert into t(rowid,e) values (?,?)").run(1n, new Uint8Array(new Float32Array([1,0,0,0]).buffer))
    console.log(p, "OK", db.prepare("select vec_version() v").get().v, JSON.stringify(db.prepare("select rowid, distance from t where e match ? and k=1").all(new Uint8Array(new Float32Array([1,0,0,0]).buffer))))
  } catch (e) { console.log(p, "ERROR", e.code, e.message) }
}
