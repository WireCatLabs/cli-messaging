/**
 * Adds to `parity.json` what the two CLIs have and it does not list yet, and sorts it. A row that
 * exists is never changed: a state, a reason and a meaning are edited by hand, and a seed must not
 * write today's differences back over them. A new one-sided row comes in as `planned` with
 * `by: "?"`, which the manifest test refuses until someone says who closes it.
 *
 *   node dist/bin/max.js commands --json > max.json; node dist/bin/tg.js commands --json > tg.json
 *   pnpm parity:seed max.json tg.json
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { CommandInfo, OptionInfo } from "@leemour/cli-core/commands"
import { type CommandsJson, coveringRow, type Entry, longName, type Manifest } from "../src/parity/manifest.ts"

const [maxFile, tgFile] = process.argv.slice(2)
if (!maxFile || !tgFile) throw new Error("usage: parity-seed <max commands.json> <tg commands.json>")

const path = join(import.meta.dirname, "../parity.json")
const manifest: Manifest = JSON.parse(readFileSync(path, "utf8"))
const read = (file: string): CommandsJson => JSON.parse(readFileSync(file, "utf8"))
const max = read(maxFile)
const tg = read(tgFile)

const commandsOf = (program: CommandsJson) => {
  const found = new Map<string, CommandInfo>()
  const walk = (command: CommandInfo) => {
    found.set(command.path.join(" "), command)
    command.commands.forEach(walk)
  }
  program.commands.forEach(walk)
  return found
}

const catalogue = (option: OptionInfo) => {
  const name = longName(option.flags)
  if (manifest.options[name]) return
  const value = /[<[][^>\]]+[>\]]/.exec(option.flags)?.[0]
  manifest.options[name] = {
    ...(value ? { value } : {}),
    meaning: option.description,
    ...(option.default === undefined ? {} : { default: String(option.default) }),
  }
}

const seedOptions = (entries: Record<string, Entry>, ours: readonly OptionInfo[], theirs: readonly OptionInfo[]) => {
  const other = new Set(theirs.map((option) => longName(option.flags)))
  for (const option of ours) {
    catalogue(option)
    const name = longName(option.flags)
    entries[name] ??= other.has(name) ? "both" : { state: "planned", by: "?" }
  }
}

const sorted = <T>(record: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))

const maxCommands = commandsOf(max)
const tgCommands = commandsOf(tg)
seedOptions(manifest.globalOptions, max.globalOptions, tg.globalOptions)
seedOptions(manifest.globalOptions, tg.globalOptions, max.globalOptions)
for (const [ours, theirs] of [
  [maxCommands, tgCommands],
  [tgCommands, maxCommands],
] as const) {
  for (const [key, command] of ours) {
    if (coveringRow(manifest, key)) continue
    const other = theirs.get(key)
    manifest.commands[key] ??= other ? { state: "both" } : { state: "planned", by: "?" }
    const row = manifest.commands[key]
    const options = { ...row.options }
    seedOptions(options, command.options, other?.options ?? [])
    if (Object.keys(options).length > 0) row.options = sorted(options)
  }
}

manifest.options = sorted(manifest.options)
manifest.globalOptions = sorted(manifest.globalOptions)
manifest.commands = sorted(manifest.commands)
writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
