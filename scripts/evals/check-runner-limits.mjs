import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = mkdtempSync(join(tmpdir(), "stats-runner-limit-check-")),
  bin = join(root, "bin")
mkdirSync(bin)
const executable = join(bin, "codex")
writeFileSync(
  executable,
  `#!${process.execPath}\nif (process.argv.includes("login")) { console.error("Logged in using ChatGPT"); process.exit(0) }\nif (process.argv.includes("--version")) { console.log("fake-codex-test"); process.exit(0) }\nif (process.env.STATS_LIMIT_TEST === "calls") for (let i=0;i<21;i++) console.log(JSON.stringify({type:"item.started",item:{id:String(i),type:"command_execution"}}))\nsetInterval(()=>{},1000)\n`,
)
chmodSync(executable, 0o755)
const hash = (text) => createHash("sha256").update(text).digest("hex")
const roots = []
for (const mode of ["timeout", "calls"]) {
  const experiment = join(root, mode),
    cwd = join(experiment, "trial")
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(experiment, "fixture.mjs"), "synthetic unused fixture")
  writeFileSync(join(experiment, "rubric.json"), "{}")
  writeFileSync(join(cwd, "prompt.txt"), "No real model is invoked.")
  writeFileSync(
    join(experiment, "manifest.json"),
    JSON.stringify({
      fixture: join(experiment, "fixture.mjs"),
      fixtureSha256: hash("synthetic unused fixture"),
      rubricSha256: hash("{}"),
      clock: "fixed",
      seed: "limits",
      contexts: [
        {
          name: "trial",
          cwd,
          mode: "cli",
          tasks: [1],
          repeat: 1,
          variant: "primary",
          promptSha256: hash("No real model is invoked."),
        },
      ],
    }),
  )
  const args = [
    fileURLToPath(new URL("run-stats-evals.mjs", import.meta.url)),
    experiment,
    "--model",
    "fake",
    "--timeoutSeconds",
    "1",
  ]
  const result = spawnSync(process.execPath, args, {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STATS_LIMIT_TEST: mode },
    encoding: "utf8",
    timeout: 10000,
  })
  assert.equal(result.status, 1)
  const outcome = JSON.parse(readFileSync(join(cwd, "run.json"), "utf8"))
  assert.equal(mode === "timeout" ? outcome.timedOut : outcome.callBudgetExceeded, true)
  const preserved = readFileSync(join(cwd, "run.json"), "utf8")
  const again = spawnSync(process.execPath, args, {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    encoding: "utf8",
    timeout: 10000,
  })
  assert.notEqual(again.status, 0)
  assert.equal(readFileSync(join(cwd, "run.json"), "utf8"), preserved)
  roots.push(experiment)
}
console.log(
  JSON.stringify({
    passed: true,
    simulatedRunner: true,
    checks: "owned child deadline/call-budget termination and no trial overwrite",
    roots,
  }),
)
