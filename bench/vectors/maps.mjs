import { readFileSync } from "node:fs"
await import("./load-plain.mjs")
console.log([...new Set(readFileSync("/proc/self/maps","utf8").split("\n").filter(l=>/sqlite3|vec0/.test(l)).map(l=>l.split(/\s+/).pop()))].join(" | "))
