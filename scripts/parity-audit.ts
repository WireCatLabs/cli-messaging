/**
 * The milestone parity audit: where tg and max stand, from `parity.json` — what both have, what is
 * planned and by whom, what stays one-sided and why, and the option clashes still open. Given both
 * CLIs' `commands --json`, it also says where each disagrees with the manifest. Markdown on stdout.
 *
 *   pnpm parity:audit [max.json tg.json]
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { type Cli, type CommandsJson, type Entry, type Manifest, parityProblems } from "../src/parity/manifest.ts"

const manifest: Manifest = JSON.parse(readFileSync(join(import.meta.dirname, "../parity.json"), "utf8"))
const [maxFile, tgFile] = process.argv.slice(2)

interface Line {
  what: string
  state: string
  note: string
}
const lines: Line[] = []
const add = (what: string, entry: Entry | Manifest["commands"][string]) => {
  if (typeof entry === "string") lines.push({ what, state: entry, note: "" })
  else lines.push({ what, state: entry.state, note: entry.reason ?? entry.by ?? "" })
}
for (const [name, entry] of Object.entries(manifest.globalOptions)) add(`(global) ${name}`, entry)
for (const [path, row] of Object.entries(manifest.commands)) {
  add(path, row)
  for (const [name, entry] of Object.entries(row.options ?? {})) add(`${path} ${name}`, entry)
}

const count = (state: string, options: boolean) =>
  lines.filter((line) => line.state === state && line.what.includes(" --") === options).length
const out: string[] = ["# Parity of tg and max", "", "| State | Commands | Options |", "|---|---|---|"]
for (const state of ["both", "planned", "max-only", "tg-only"])
  out.push(`| ${state} | ${count(state, false)} | ${count(state, true)} |`)

const planned = Map.groupBy(
  lines.filter((line) => line.state === "planned"),
  (line) => line.note,
)
out.push("", "## Planned, by who closes it", "")
for (const [by, group] of [...planned].sort(([a], [b]) => a.localeCompare(b)))
  out.push(`- **${by}** (${group.length}): ${group.map((line) => `\`${line.what}\``).join(", ")}`)

out.push("", "## One-sided, and why", "")
for (const line of lines.filter((one) => one.state.endsWith("-only")))
  out.push(`- \`${line.what}\` — ${line.state}: ${line.note}`)

out.push("", "## Option clashes still open", "")
for (const [name, option] of Object.entries(manifest.options))
  if (option.note) out.push(`- \`${name}\` — ${option.note}`)

if (maxFile && tgFile) {
  out.push("", "## Each CLI against the manifest", "")
  for (const [cli, file] of [
    ["max", maxFile],
    ["tg", tgFile],
  ] as [Cli, string][]) {
    const program: CommandsJson = JSON.parse(readFileSync(file, "utf8"))
    const problems = parityProblems(manifest, cli, program)
    out.push(
      `- **${cli}** — ${problems.length === 0 ? "agrees" : problems.map((problem) => `\`${problem}\``).join("; ")}`,
    )
  }
}
console.log(out.join("\n"))
