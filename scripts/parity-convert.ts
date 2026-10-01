/**
 * One-off: rewrites a two-CLI `parity.json` (states `both`, `max-only`, `tg-only`, `planned`) into
 * the N-CLI shape (`clis`, and `in` on every row). Run it again on a branch that still edits the old
 * shape after rebasing onto the new one, instead of merging by hand. A file already converted is left
 * as it is.
 *
 * `planned` becomes planned for both CLIs with the same `by`: the old state never said which CLI the
 * gap was in, and some planned rows are options a CLI still has and is about to drop. Narrowing them
 * to the CLI that lacks it is a hand edit by whoever owns the row.
 *
 *   node --experimental-strip-types scripts/parity-convert.ts
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

type Old = "both" | { state: "max-only" | "tg-only" | "planned" | "both"; reason?: string; by?: string }
interface OldRow {
  state: string
  reason?: string
  by?: string
  subtree?: boolean
  options?: Record<string, Old>
}

const presence = (state: string, reason?: string, by?: string) => {
  if (state === "both") return { in: "all" }
  if (state === "max-only" || state === "tg-only") return { in: [state.slice(0, -"-only".length)], reason }
  if (state === "planned") return { in: [], planned: { max: by, tg: by } }
  throw new Error(`no such state "${state}"`)
}

const option = (entry: Old) => (entry === "both" ? "all" : presence(entry.state, entry.reason, entry.by))

const path = join(import.meta.dirname, "../parity.json")
const old = JSON.parse(readFileSync(path, "utf8"))
if (!old.clis) {
  const options = (entries: Record<string, Old>) =>
    Object.fromEntries(Object.entries(entries).map(([name, entry]) => [name, option(entry)]))
  const converted = {
    clis: ["max", "tg"],
    options: old.options,
    globalOptions: options(old.globalOptions),
    commands: Object.fromEntries(
      Object.entries(old.commands as Record<string, OldRow>).map(([command, row]) => [
        command,
        {
          ...presence(row.state, row.reason, row.by),
          ...(row.subtree ? { subtree: true } : {}),
          ...(row.options ? { options: options(row.options) } : {}),
        },
      ]),
    ),
  }
  const json = JSON.stringify(converted, null, 2).replace(
    /\[\s+((?:"[^"]*",?\s*)+)\]/g,
    (_, items: string) => `[${items.trim().split(/,\s*/).join(", ")}]`,
  )
  writeFileSync(path, `${json}\n`)
}
