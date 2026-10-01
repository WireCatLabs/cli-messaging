import { DatabaseSync } from "node:sqlite"
import * as sqliteVec from "sqlite-vec"
console.log("node", process.version, "path", sqliteVec.getLoadablePath())
const db = new DatabaseSync(":memory:", { allowExtension: true })
console.log("sqlite", db.prepare("select sqlite_version() v").get().v)
try {
  db.loadExtension(sqliteVec.getLoadablePath())
  console.log("vec_version", db.prepare("select vec_version() v").get().v)
  db.exec("create virtual table t using vec0(e float[4])")
  db.prepare("insert into t(rowid,e) values (?,?)").run(1n, new Uint8Array(new Float32Array([1,0,0,0]).buffer))
  console.log(db.prepare("select rowid, distance from t where e match ? and k=1").all(new Uint8Array(new Float32Array([1,0,0,0]).buffer)))
} catch (e) { console.log("ERROR", e.code, e.message) }
try { sqliteVec.load(db); console.log("sqliteVec.load ok") } catch (e) { console.log("load() ERROR", e.message) }
const db2 = new DatabaseSync(":memory:")
try { db2.loadExtension(sqliteVec.getLoadablePath()) } catch (e) { console.log("without allowExtension:", e.code, e.message) }
