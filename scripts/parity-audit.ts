/**
 * The milestone parity audit: where tg and max stand, from `parity.json` — what both have, what is
 * planned and by whom, what stays one-sided and why, and the option clashes still open. Given both
 * CLIs' checkouts, built, it also measures them: the checks CI runs, the shared versions they pin,
 * their MCP tools, user pages, README sections and release tooling. Markdown on stdout.
 *
 *   pnpm parity:audit                          # the manifest alone
 *   pnpm parity:audit --max <dir> --tg <dir>   # and two built checkouts
 *   pnpm parity:audit --fresh                  # clones and builds both CLIs' main first
 *
 * Nothing contacts Telegram or MAX: each MCP server starts in an empty temporary home, with no
 * profile, and is asked only for its list of tools.
 */
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { allowFlags, type CliSide, renderAudit } from "../dist/parity/audit.js"
import type { CommandsJson, Entry, Manifest } from "../dist/parity/manifest.js"

const root = join(import.meta.dirname, "..")
const manifest: Manifest = JSON.parse(readFileSync(join(root, "parity.json"), "utf8"))
const { values } = parseArgs({
  options: { max: { type: "string" }, tg: { type: "string" }, fresh: { type: "boolean" } },
})

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

const planned = new Map<string, Line[]>()
for (const line of lines.filter((one) => one.state === "planned"))
  planned.set(line.note, [...(planned.get(line.note) ?? []), line])
out.push("", "## Planned, by who closes it", "")
for (const [by, group] of [...planned].sort(([a], [b]) => a.localeCompare(b)))
  out.push(`- **${by}** (${group.length}): ${group.map((line) => `\`${line.what}\``).join(", ")}`)

out.push("", "## One-sided, and why", "")
for (const line of lines.filter((one) => one.state.endsWith("-only")))
  out.push(`- \`${line.what}\` — ${line.state}: ${line.note}`)

out.push("", "## Option clashes still open", "")
for (const [name, option] of Object.entries(manifest.options))
  if (option.note) out.push(`- \`${name}\` — ${option.note}`)

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim()

const fresh = (): { max: string; tg: string } => {
  const dir = mkdtempSync(join(tmpdir(), "parity-audit-"))
  for (const cli of ["max", "tg"]) {
    const into = join(dir, cli)
    console.error(`cloning and building ${cli}-cli into ${into}`)
    execFileSync("git", ["clone", "-q", "--depth", "1", `https://github.com/leemour/${cli}-cli.git`, into])
    execFileSync("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], { cwd: into, stdio: "ignore" })
    execFileSync("pnpm", ["build"], { cwd: into, stdio: "ignore" })
  }
  return { max: join(dir, "max"), tg: join(dir, "tg") }
}

const mcpTools = (bin: string, flags: string[]): Promise<string[]> => {
  const home = mkdtempSync(join(tmpdir(), "parity-home-"))
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_STATE_HOME: join(home, "state"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_DATA_HOME: join(home, "data"),
    TMPDIR: home,
  }
  const child = spawn("node", [bin, "mcp", ...flags], { stdio: ["pipe", "pipe", "ignore"], env })
  const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${bin} mcp gave no list of tools in 30 s`))
    }, 30_000)
    let buffer = ""
    child.stdout.on("data", (chunk) => {
      buffer += chunk
      for (const line of buffer.split("\n")) {
        if (!line.includes('"id":2')) continue
        clearTimeout(timer)
        child.kill()
        resolve((JSON.parse(line).result.tools as { name: string }[]).map((tool) => tool.name).sort())
      }
    })
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "parity-audit", version: "0" } },
    })
    send({ jsonrpc: "2.0", method: "notifications/initialized" })
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
  })
}

const markdown = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".md")) : [])

const side = async (cli: "max" | "tg", dir: string): Promise<CliSide> => {
  const bin = join(dir, "dist/bin", `${cli}.js`)
  const program: CommandsJson = JSON.parse(execFileSync("node", [bin, "commands", "--json"], { encoding: "utf8" }))
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
  const scripts: Record<string, string> = pkg.scripts ?? {}
  const pins = Object.fromEntries(
    Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).filter(([name]) => name.startsWith("@leemour/")),
  ) as Record<string, string>
  const pages: Record<string, string> = { "README.md": readFileSync(join(dir, "README.md"), "utf8") }
  for (const name of markdown(join(dir, "docs"))) pages[`docs/${name}`] = readFileSync(join(dir, "docs", name), "utf8")
  const workflows = join(dir, ".github/workflows")
  const ci = readdirSync(workflows)
    .map((name) => readFileSync(join(workflows, name), "utf8"))
    .join("\n")
    .replace(/pnpm (?:run )?([\w:-]+)/g, (run, name: string) => `${run} ${scripts[name] ?? ""}`)
  const skills = [".claude/skills", "docs/dev/skills"].flatMap((folder) =>
    existsSync(join(dir, folder)) ? readdirSync(join(dir, folder)) : [],
  )
  return {
    commit: git(dir, "rev-parse", "--short", "HEAD"),
    pins,
    program,
    tools: await mcpTools(bin, allowFlags(program)),
    pages,
    scripts: Object.keys(scripts).filter((name) => !name.startsWith("probe:")),
    skills,
    ci,
  }
}

const dirs = values.fresh ? fresh() : values.max && values.tg ? { max: values.max, tg: values.tg } : undefined
if (dirs) {
  const [max, tg] = await Promise.all([side("max", dirs.max), side("tg", dirs.tg)])
  out.push(
    "",
    renderAudit({
      shared: {
        commit: git(root, "rev-parse", "--short", "HEAD"),
        version: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
      },
      manifest,
      standard: readFileSync(join(root, "docs/dev/STANDARD.md"), "utf8"),
      max,
      tg,
    }),
  )
} else if (values.max || values.tg) {
  console.error("usage: pnpm parity:audit [--fresh | --max <dir> --tg <dir>]")
  process.exit(2)
}
console.log(out.join("\n"))
