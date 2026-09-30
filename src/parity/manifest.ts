import type { CommandInfo, OptionInfo } from "@leemour/cli-core/commands"

export type Cli = "max" | "tg"
export type State = "both" | "max-only" | "tg-only" | "planned"

/** `"both"`, or a one-sided or planned entry that says why (`reason`) or who closes it (`by`). */
export type Entry = "both" | { state: Exclude<State, "both">; reason?: string; by?: string }

export interface CommandRow {
  state: State
  reason?: string
  by?: string
  options?: Record<string, Entry>
}

export interface CatalogueOption {
  value?: string
  meaning: string
  default?: string
  note?: string
}

export interface Manifest {
  options: Record<string, CatalogueOption>
  globalOptions: Record<string, Entry>
  commands: Record<string, CommandRow>
}

/** What `commands --json` prints, as far as the check reads it. */
export interface CommandsJson {
  cli: string
  globalOptions: readonly OptionInfo[]
  commands: readonly CommandInfo[]
}

const STATES: readonly State[] = ["both", "max-only", "tg-only", "planned"]

export const longName = (flags: string): string => flags.split(/[\s,|]+/).find((part) => part.startsWith("--")) ?? flags

const stateOf = (entry: Entry | CommandRow): State => (typeof entry === "string" ? entry : entry.state)

const entryProblems = (where: string, entry: Entry | CommandRow): string[] => {
  if (typeof entry === "string") return entry === "both" ? [] : [`${where}: "${entry}" — only "both" stands alone`]
  const problems: string[] = []
  if (!STATES.includes(entry.state)) problems.push(`${where}: no such state "${entry.state}"`)
  if (entry.state === "max-only" || entry.state === "tg-only") {
    if (!entry.reason) problems.push(`${where}: ${entry.state} without a reason`)
  } else if (entry.reason) problems.push(`${where}: a reason on a ${entry.state} row`)
  if (entry.state === "planned" && !entry.by) problems.push(`${where}: planned without "by"`)
  if (entry.state !== "planned" && entry.by) problems.push(`${where}: "by" on a ${entry.state} row`)
  return problems
}

const unsorted = (where: string, keys: string[]): string[] => {
  const sorted = [...keys].sort()
  const at = keys.findIndex((key, index) => key !== sorted[index])
  return at === -1 ? [] : [`${where}: keys out of order at "${keys[at]}" — run the seed to sort`]
}

const oneSided = (state: State) => state === "max-only" || state === "tg-only"

/** The one-sided row above `path`, which covers it and everything else below it. */
export const coveringRow = (manifest: Manifest, path: string): string | undefined => {
  const words = path.split(" ")
  for (let length = words.length - 1; length > 0; length--) {
    const parent = words.slice(0, length).join(" ")
    const row = manifest.commands[parent]
    if (row && oneSided(row.state)) return parent
  }
  return undefined
}

/** Everything wrong with the manifest itself; empty when it is well-formed. */
export const manifestProblems = (manifest: Manifest): string[] => {
  const problems: string[] = [
    ...unsorted("options", Object.keys(manifest.options)),
    ...unsorted("globalOptions", Object.keys(manifest.globalOptions)),
    ...unsorted("commands", Object.keys(manifest.commands)),
  ]
  const used = new Set<string>()
  const optionEntries = (where: string, options: Record<string, Entry>) => {
    problems.push(...unsorted(`${where} options`, Object.keys(options)))
    for (const [name, entry] of Object.entries(options)) {
      used.add(name)
      if (!manifest.options[name]) problems.push(`${where} ${name}: not in the option catalogue`)
      problems.push(...entryProblems(`${where} ${name}`, entry))
    }
  }

  optionEntries("(global)", manifest.globalOptions)
  for (const [path, row] of Object.entries(manifest.commands)) {
    problems.push(...entryProblems(path, row))
    const parent = path.split(" ").slice(0, -1).join(" ")
    if (parent && !manifest.commands[parent]) problems.push(`${path}: no row for its parent "${parent}"`)
    const cover = coveringRow(manifest, path)
    if (cover) problems.push(`${path}: under "${cover}", which is ${manifest.commands[cover]?.state} and covers it`)
    optionEntries(path, row.options ?? {})
  }

  for (const [name, option] of Object.entries(manifest.options)) {
    if (!option.meaning) problems.push(`options ${name}: no meaning`)
    if (!used.has(name)) problems.push(`options ${name}: in the catalogue, on no command`)
  }
  return problems
}

const present = (cli: Cli, state: State): boolean | undefined =>
  state === "planned" ? undefined : state === "both" || state === `${cli}-only`

const compare = (cli: Cli, where: string, state: State | undefined, has: boolean): string[] => {
  if (state === undefined) return has ? [`${where}: not in the manifest — add its row first`] : []
  const expected = present(cli, state)
  if (expected === undefined || expected === has) return []
  return has
    ? [`${where}: ${cli} has it, the manifest says ${state}`]
    : [`${where}: the manifest says ${state}, ${cli} lacks it`]
}

const optionsOf = (options: readonly OptionInfo[]) => new Set(options.map((option) => longName(option.flags)))

const compareOptions = (cli: Cli, where: string, entries: Record<string, Entry>, options: readonly OptionInfo[]) => {
  const has = optionsOf(options)
  return [...new Set([...has, ...Object.keys(entries)])].sort().flatMap((name) => {
    const entry = entries[name]
    return compare(cli, `${where} ${name}`, entry === undefined ? undefined : stateOf(entry), has.has(name))
  })
}

/** Where a CLI's `commands --json` disagrees with its column of the manifest; empty when it agrees. */
export const parityProblems = (manifest: Manifest, cli: Cli, program: CommandsJson): string[] => {
  const found = new Map<string, CommandInfo>()
  const walk = (command: CommandInfo) => {
    found.set(command.path.join(" "), command)
    command.commands.forEach(walk)
  }
  program.commands.forEach(walk)

  const problems = compareOptions(cli, "(global)", manifest.globalOptions, program.globalOptions)
  const paths = [...new Set([...found.keys(), ...Object.keys(manifest.commands)])].sort()
  for (const path of paths) {
    if (coveringRow(manifest, path)) continue
    const row = manifest.commands[path]
    const command = found.get(path)
    problems.push(...compare(cli, path, row?.state, command !== undefined))
    if (row && command && present(cli, row.state) !== false && !oneSided(row.state))
      problems.push(...compareOptions(cli, path, row.options ?? {}, command.options))
  }
  return problems
}
