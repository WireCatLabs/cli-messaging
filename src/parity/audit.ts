import type { CommandInfo } from "@leemour/cli-core/commands"
import { type CommandsJson, longName, type Manifest, parityProblems } from "./manifest.js"
import { pageProblems } from "./pages.js"
import { wordingProblems } from "./wording.js"

/** What the audit reads from one CLI's checkout and build. Gathered by `scripts/parity-audit.ts`. */
export interface CliSide {
  commit: string
  /** The `@leemour/*` packages it pins, by name. */
  pins: Record<string, string>
  program: CommandsJson
  /** `tools/list` of its MCP server with every `--allow-*`, prefix kept. */
  tools: string[]
  /** `README.md` and `docs/*.md`, by path from the checkout, with their text. */
  pages: Record<string, string>
  scripts: string[]
  skills: string[]
  /** Its CI workflows, with each `pnpm <script>` they run followed by that script's command. */
  ci: string
}

export interface AuditInput {
  shared: { commit: string; version: string }
  manifest: Manifest
  /** STANDARD.md, whose Documents rule names the pages one tool has alone. */
  standard: string
  max: CliSide
  tg: CliSide
}

export interface Split {
  both: string[]
  max: string[]
  tg: string[]
}

export const split = (max: Iterable<string>, tg: Iterable<string>): Split => {
  const inMax = new Set(max)
  const inTg = new Set(tg)
  return {
    both: [...inMax].filter((name) => inTg.has(name)).sort(),
    max: [...inMax].filter((name) => !inTg.has(name)).sort(),
    tg: [...inTg].filter((name) => !inMax.has(name)).sort(),
  }
}

/** The pages that answer a user's question: the generated command list and the docs index are not counted. */
const NOT_PAGES = new Set(["docs/commands.md", "docs/README.md"])
const userPages = (side: CliSide) =>
  Object.keys(side.pages)
    .filter((path) => path.startsWith("docs/") && !NOT_PAGES.has(path))
    .map((path) => path.slice("docs/".length))
const lineCount = (text = "") => text.split("\n").length - 1

const documentsRule = (standard: string) => standard.split(/^## Documents$/m)[1]?.split(/^## /m)[0] ?? ""

export const pageSplit = (input: AuditInput) => {
  const pages = split(userPages(input.max), userPages(input.tg))
  const rule = documentsRule(input.standard)
  const explained = (name: string) => rule.includes(`\`${name}\``)
  return { ...pages, explained }
}

export const readmeSections = (readme = "") => [...readme.matchAll(/^## (.+)$/gm)].map((match) => match[1] ?? "")

export const toolNames = (side: CliSide, cli: string) => side.tools.map((name) => name.replace(`${cli}_`, ""))

/** The `--allow-*` options of a CLI's `mcp` command: passing them all makes its server offer every tool. */
export const allowFlags = (program: CommandsJson): string[] => {
  const mcp = program.commands.find((command: CommandInfo) => command.path.join(" ") === "mcp")
  return (mcp?.options ?? []).map((option) => longName(option.flags)).filter((name) => name.startsWith("--allow-"))
}

export const ciRuns = (side: CliSide) => ({
  parity: side.ci.includes("cli-messaging-parity"),
  pages: /cli-messaging-parity \S+ --pages/.test(side.ci),
})

const mark = (ok: boolean) => (ok ? "✅" : "🔴")
const code = (names: string[]) => (names.length === 0 ? "none" : names.map((name) => `\`${name}\``).join(", "))

/** The measured half of a parity audit, as Markdown: everything a script can say without judging. */
export const renderAudit = (input: AuditInput): string => {
  const { manifest, max, tg } = input
  const out: string[] = []
  const section = (title: string) => out.push("", `### ${title}`, "")

  out.push(
    "## Measured from the two CLIs",
    "",
    `cli-messaging \`${input.shared.commit}\` (${input.shared.version}) · max-cli \`${max.commit}\` · ` +
      `tg-cli \`${tg.commit}\`. Statuses: ✅ agrees · 🔴 differs · ⚪ one-sided with a stated reason.`,
  )

  section("The checks CI runs")
  const maxProblems = parityProblems(manifest, "max", max.program)
  const tgProblems = parityProblems(manifest, "tg", tg.program)
  const wording = wordingProblems(manifest, max.program, tg.program)
  const pageCheck = (cli: "max" | "tg", side: CliSide) =>
    Object.entries(side.pages).flatMap(([name, text]) =>
      pageProblems(text, cli, manifest, side.program).map((found) => `${name}: ${found}`),
    )
  const pagesMax = pageCheck("max", max)
  const pagesTg = pageCheck("tg", tg)
  out.push(
    `- ${mark(maxProblems.length === 0)} **max against this manifest** — ${maxProblems.length} difference(s) ${code(maxProblems)}`,
    `- ${mark(tgProblems.length === 0)} **tg against this manifest** — ${tgProblems.length} difference(s) ${code(tgProblems)}`,
    `- ${mark(wording.length === 0)} **Help sentences of shared options** — ${wording.length} differ ${code(wording)}`,
    `- ${mark(pagesMax.length === 0)} **max's pages name only real options** — ${code(pagesMax)}`,
    `- ${mark(pagesTg.length === 0)} **tg's pages name only real options** — ${code(pagesTg)}`,
  )
  for (const [cli, side] of [
    ["max", max],
    ["tg", tg],
  ] as const) {
    const runs = ciRuns(side)
    out.push(
      `- ${mark(runs.parity)} **${cli}'s CI runs the parity check**`,
      `- ${mark(runs.pages)} **${cli}'s CI runs the page check** (STANDARD, Documents rule 4)`,
    )
  }

  section("Shared package pinned")
  for (const name of ["@leemour/cli-messaging", "@leemour/cli-core"]) {
    const latest = name === "@leemour/cli-messaging" ? input.shared.version : undefined
    const pins = [max.pins[name], tg.pins[name]]
    const same = pins[0] === pins[1] && (latest === undefined || pins[0] === latest)
    out.push(
      `- ${mark(same)} **${name}** — max ${pins[0] ?? "none"}, tg ${pins[1] ?? "none"}` +
        (latest ? `, main ${latest}` : ""),
    )
  }

  section("MCP tools")
  const tools = split(toolNames(max, "max"), toolNames(tg, "tg"))
  out.push(
    `- **Both** (${tools.both.length}) — ${code(tools.both)}`,
    `- **max only** (${tools.max.length}) — ${code(tools.max)}`,
    `- **tg only** (${tools.tg.length}) — ${code(tools.tg)}`,
  )

  section("User pages")
  const pages = pageSplit(input)
  for (const name of pages.both) {
    const lines = [lineCount(max.pages[`docs/${name}`]), lineCount(tg.pages[`docs/${name}`])] as const
    const short = Math.min(...lines) / Math.max(...lines)
    out.push(`- ${short >= 0.75 ? "✅" : "🔴"} \`${name}\` — max ${lines[0]} lines, tg ${lines[1]}`)
  }
  for (const [cli, names] of [
    ["max", pages.max],
    ["tg", pages.tg],
  ] as const)
    for (const name of names)
      out.push(
        `- ${pages.explained(name) ? "⚪" : "🔴"} \`${name}\` — ${cli} only; ` +
          (pages.explained(name) ? "STANDARD says why" : "STANDARD gives no reason"),
      )
  out.push("", "A pair is 🔴 when the shorter page has under three quarters of the longer one's lines.")

  section("README sections")
  const sections = [readmeSections(max.pages["README.md"]), readmeSections(tg.pages["README.md"])] as const
  out.push(
    `- ${mark(sections[0].length === sections[1].length)} max ${sections[0].length}, tg ${sections[1].length}`,
    `- **max:** ${sections[0].join(" · ")}`,
    `- **tg:** ${sections[1].join(" · ")}`,
  )

  section("Release and QA tooling")
  const scripts = split(max.scripts, tg.scripts)
  const skills = split(max.skills, tg.skills)
  out.push(
    `- **pnpm scripts in max only** — ${code(scripts.max)}`,
    `- **pnpm scripts in tg only** — ${code(scripts.tg)}`,
    `- **Skills in both** — ${code(skills.both)}; max only ${code(skills.max)}; tg only ${code(skills.tg)}`,
  )
  return out.join("\n")
}
