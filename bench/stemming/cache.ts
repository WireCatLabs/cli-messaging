// What the per-word stem cache saves: stemTokens over every message of the synthetic corpus of
// bench/search/gen.ts, with no cache, with the default bounded cache, and with an unbounded one.
//
//   pnpm build && SEARCHBENCH_DATA=<dir with corpus-N.tsv> node bench/stemming/cache.ts N
import { createReadStream } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"

const dist = join(import.meta.dirname, "../../dist/search/stem.js")
const { createStemmer, STEM_CACHE_LIMIT } = (await import(dist)) as typeof import("../../src/search/stem.ts")

const N = Number(process.argv[2])
const dir = process.env.SEARCHBENCH_DATA
if (!Number.isInteger(N) || !dir) throw new Error("usage: SEARCHBENCH_DATA=… node bench/stemming/cache.ts N")

const texts: string[] = []
for await (const line of createInterface({ input: createReadStream(join(dir, `corpus-${N}.tsv`)) }))
  texts.push(line.split("\t")[5] as string)

const TOKEN = /[\p{L}\p{N}\p{Co}\p{M}]+/gu
let tokens = 0
const distinct = new Set<string>()
let clears = 0
let misses = 0
let held = new Set<string>()
for (const text of texts)
  for (const token of text.normalize("NFC").toLowerCase().match(TOKEN) ?? []) {
    tokens++
    distinct.add(token)
    if (held.has(token)) continue
    misses++
    if (held.size >= STEM_CACHE_LIMIT) {
      held = new Set()
      clears++
    }
    held.add(token)
  }

const run = (cacheLimit: number) => {
  const stemmer = createStemmer(undefined, { cacheLimit })
  const start = performance.now()
  for (const text of texts) stemmer.stemTokens(text)
  return (performance.now() - start) / 1000
}

console.log(`node ${process.version}; ${N.toLocaleString("en")} messages, ${tokens.toLocaleString("en")} tokens,`)
console.log(`${distinct.size.toLocaleString("en")} distinct; limit ${STEM_CACHE_LIMIT.toLocaleString("en")} clears ${clears} times, ${misses.toLocaleString("en")} misses`)
console.log("| cache | stemTokens over all messages, 3 runs | median |")
console.log("|---|---|---|")
for (const [label, limit] of [
  ["none", 0],
  [`bounded (${STEM_CACHE_LIMIT.toLocaleString("en")})`, STEM_CACHE_LIMIT],
  ["unbounded", Number.POSITIVE_INFINITY],
] as const)
{
  const times = [run(limit), run(limit), run(limit)]
  console.log(`| ${label} | ${times.map((t) => t.toFixed(1)).join(" / ")} s | ${[...times].sort((a, b) => a - b)[1]?.toFixed(1)} s |`)
}
