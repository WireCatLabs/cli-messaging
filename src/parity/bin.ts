#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { type Cli, type Manifest, parityProblems } from "./manifest.js"
import { pageProblems } from "./pages.js"

const [cli, flag, ...pages] = process.argv.slice(2)
if ((cli !== "max" && cli !== "tg") || (flag !== undefined && (flag !== "--pages" || pages.length === 0))) {
  console.error("usage: <tool> commands --json | cli-messaging-parity <max|tg> [--pages <file...>]")
  process.exit(2)
}

const manifest: Manifest = JSON.parse(readFileSync(new URL("../../parity.json", import.meta.url), "utf8"))
const program = JSON.parse(readFileSync(0, "utf8"))

if (flag === "--pages") {
  const problems = pages.flatMap((page) =>
    pageProblems(readFileSync(page, "utf8"), cli satisfies Cli, manifest, program).map(
      (found) => `${page}: ${found} — no such option, and the parity manifest plans none for ${cli}`,
    ),
  )
  for (const problem of problems) console.error(problem)
  if (problems.length > 0) process.exit(1)
} else {
  const problems = parityProblems(manifest, cli satisfies Cli, program)
  for (const problem of problems) console.error(problem)
  if (problems.length > 0) {
    console.error(`${problems.length} difference(s) from @leemour/cli-messaging parity.json — see docs/dev/STANDARD.md`)
    process.exit(1)
  }
}
