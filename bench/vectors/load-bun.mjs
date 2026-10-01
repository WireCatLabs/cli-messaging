import { Database } from "bun:sqlite"
import * as sqliteVec from "sqlite-vec"
console.log("bun", Bun.version)
const db = new Database(":memory:")
console.log("sqlite", db.query("select sqlite_version() v").get().v)
try {
  db.loadExtension(sqliteVec.getLoadablePath())
  console.log("vec_version", db.query("select vec_version() v").get().v)
  db.exec("create virtual table t using vec0(e float[4])")
  db.query("insert into t(rowid,e) values (?,?)").run(1, new Float32Array([1,0,0,0]))
  console.log(db.query("select rowid, distance from t where e match ? and k=1").all(new Float32Array([1,0,0,0])))
} catch (e) { console.log("ERROR", e.message) }
