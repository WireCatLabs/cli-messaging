import { Database } from "bun:sqlite"
try { Database.setCustomSQLite(process.argv[2]); console.log("setCustomSQLite ok") } catch (e) { console.log("setCustomSQLite ERROR", e.message) }
const db = new Database(":memory:")
console.log("sqlite", db.query("select sqlite_version() v").get().v)
try { db.loadExtension(process.argv[3]); console.log("vec", db.query("select vec_version() v").get().v) } catch (e) { console.log("ERROR", e.message) }
