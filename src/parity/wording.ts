import type { CommandInfo } from "@leemour/cli-core/commands"
import { type CommandsJson, type Entry, longName, type Manifest } from "./manifest.js"

const descriptions = (program: CommandsJson): Map<string, string> => {
  const found = new Map<string, string>()
  for (const option of program.globalOptions) found.set(`(global) ${longName(option.flags)}`, option.description)
  const walk = (command: CommandInfo) => {
    for (const option of command.options)
      found.set(`${command.path.join(" ")} ${longName(option.flags)}`, option.description)
    command.commands.forEach(walk)
  }
  program.commands.forEach(walk)
  return found
}

const sharedBy = (manifest: Manifest, entry: Entry): string[] => {
  const where = typeof entry === "string" ? entry : entry.in
  return where === "all" ? manifest.clis : where
}

/**
 * Every shared option that the CLIs having it describe in different words; each program is known by
 * its `cli`. An option whose catalogue entry has a `note` is a clash already written down, and is left
 * to whoever the note names.
 */
export const wordingProblems = (manifest: Manifest, programs: readonly CommandsJson[]): string[] => {
  const rows = [
    ...Object.entries(manifest.globalOptions).map(([name, entry]) => ["(global)", name, entry] as const),
    ...Object.entries(manifest.commands).flatMap(([path, row]) =>
      Object.entries(row.options ?? {}).map(([name, entry]) => [path, name, entry] as const),
    ),
  ]
  const said = new Map(programs.map((program) => [program.cli, descriptions(program)]))
  return rows.flatMap(([path, name, entry]) => {
    if (manifest.options[name]?.note) return []
    const where = `${path} ${name}`
    const clis = sharedBy(manifest, entry).filter((cli) => said.has(cli))
    if (clis.length < 2) return []
    const sentences = clis.map((cli) => said.get(cli)?.get(where))
    if (sentences.every((sentence) => sentence === sentences[0])) return []
    return [`${where}: ${clis.map((cli, index) => `${cli} says "${sentences[index]}"`).join(", ")}`]
  })
}
