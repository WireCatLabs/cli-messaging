#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { type Cli, type Manifest, parityProblems } from "./manifest.js"

const cli = process.argv[2]
if (cli !== "max" && cli !== "tg") {
  console.error("usage: <tool> commands --json | cli-messaging-parity <max|tg>")
  process.exit(2)
}

const manifest: Manifest = JSON.parse(readFileSync(new URL("../../parity.json", import.meta.url), "utf8"))
const problems = parityProblems(manifest, cli satisfies Cli, JSON.parse(readFileSync(0, "utf8")))
for (const problem of problems) console.error(problem)
if (problems.length > 0) {
  console.error(`${problems.length} difference(s) from @leemour/cli-messaging parity.json — see docs/dev/STANDARD.md`)
  process.exit(1)
}
