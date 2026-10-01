import type { CommandInfo } from "@leemour/cli-core/commands"
import { type CommandsJson, longName, type Manifest } from "./manifest.js"

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

/**
 * Every `both` option the two tools describe in different words. An option whose catalogue entry has a
 * `note` is a clash already written down, and is left to whoever the note names.
 */
export const wordingProblems = (manifest: Manifest, max: CommandsJson, tg: CommandsJson): string[] => {
  const rows = [
    ...Object.entries(manifest.globalOptions).map(([name, entry]) => ["(global)", name, entry] as const),
    ...Object.entries(manifest.commands).flatMap(([path, row]) =>
      Object.entries(row.options ?? {}).map(([name, entry]) => [path, name, entry] as const),
    ),
  ]
  const inMax = descriptions(max)
  const inTg = descriptions(tg)
  return rows
    .filter(([, name, entry]) => entry === "both" && !manifest.options[name]?.note)
    .map(([path, name]) => `${path} ${name}`)
    .filter((where) => inMax.get(where) !== inTg.get(where))
    .map((where) => `${where}: max says "${inMax.get(where)}", tg says "${inTg.get(where)}"`)
}
