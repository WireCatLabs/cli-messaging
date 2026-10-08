import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const [directory, ...flags] = process.argv.slice(2)
const options = { model: null, reasoning: "low", concurrency: 2, timeoutSeconds: 480, only: null }
for (let i = 0; i < flags.length; i++) {
  const key = flags[i].replace(/^--/, "")
  if (!(key in options) || !flags[i + 1]) throw new Error(`unknown/missing option ${flags[i]}`)
  const value = flags[++i]
  options[key] = ["concurrency", "timeoutSeconds"].includes(key) ? Number(value) : value
}
if (
  !directory ||
  !options.model ||
  !Number.isInteger(options.concurrency) ||
  options.concurrency < 1 ||
  options.concurrency > 3 ||
  !Number.isFinite(options.timeoutSeconds) ||
  options.timeoutSeconds < 1 ||
  options.timeoutSeconds > 900
)
  throw new Error(
    "usage: node run-stats-evals.mjs <prepared-root> --model <explicit-id> [--reasoning low] [--concurrency 1-3] [--timeoutSeconds 1-900] [--only substring]",
  )
const root = resolve(directory),
  manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"))
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
if (
  hash(readFileSync(manifest.fixture)) !== manifest.fixtureSha256 ||
  hash(readFileSync(join(root, "rubric.json"))) !== manifest.rubricSha256
)
  throw new Error("fixture or preregistered rubric changed since preparation")
const selected = manifest.contexts.filter((context) => !options.only || context.name.includes(options.only))
if (!selected.length) throw new Error("no selected contexts")
for (const context of selected) {
  if (existsSync(join(context.cwd, "run.json")))
    throw new Error(`trial already exists: ${context.name}; prepare a new root to preserve the first run`)
  if (hash(readFileSync(join(context.cwd, "prompt.txt"))) !== context.promptSha256)
    throw new Error(`prompt changed: ${context.name}`)
}
const runnerSha256 = hash(readFileSync(fileURLToPath(import.meta.url)))
const version = spawnSync("codex", ["--version"], { encoding: "utf8" })
if (version.status !== 0) throw new Error("Codex runner unavailable")
writeFileSync(
  join(root, `runner-${Date.now()}.json`),
  JSON.stringify(
    {
      startedAt: new Date().toISOString(),
      requestedModel: options.model,
      runnerSha256,
      resolvedBackendSnapshot: null,
      runnerVersion: version.stdout.trim(),
      nodeVersion: process.version,
      reasoning: options.reasoning,
      options,
      fixtureSha256: manifest.fixtureSha256,
      clock: manifest.clock,
      seed: manifest.seed,
      contexts: selected.map((context) => context.name),
    },
    null,
    2,
  ),
)
const toml = (value) => JSON.stringify(value)
let cursor = 0,
  failures = 0
const run = async (context) => {
  const events = createWriteStream(join(context.cwd, "events.jsonl"), { flags: "wx" }),
    diagnostics = createWriteStream(join(context.cwd, "runner.log"), { flags: "wx" })
  const args = [
    "exec",
    "--ignore-user-config",
    "--ephemeral",
    "--skip-git-repo-check",
    "--model",
    options.model,
    "--sandbox",
    "workspace-write",
    "-c",
    'approval_policy="never"',
    "-c",
    `model_reasoning_effort=${toml(options.reasoning)}`,
    "-C",
    context.cwd,
    "--json",
    "-o",
    join(context.cwd, "final.md"),
  ]
  if (context.mode === "native-mcp") {
    for (const [server, state] of [
      ["stats", context.state],
      ["blocked_stats", context.deniedState],
    ]) {
      const prefix = `mcp_servers.${server}`
      args.push(
        "-c",
        `${prefix}.command=${toml(process.execPath)}`,
        "-c",
        `${prefix}.args=[${toml(manifest.fixture)},"__serve"]`,
        "-c",
        `${prefix}.default_tools_approval_mode="approve"`,
      )
      for (const [key, value] of Object.entries({ ...context.fixtureEnv, STATS_EVAL_ROOT: state }))
        args.push("-c", `${prefix}.env.${key}=${toml(value)}`)
    }
  }
  args.push("-")
  const started = new Date().toISOString(),
    timerStart = performance.now()
  let timedOut = false,
    callBudgetExceeded = false,
    actionCalls = 0,
    eventBuffer = "",
    error = null
  const child = spawn("codex", args, {
    cwd: context.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  })
  child.stdout.pipe(events)
  child.stderr.pipe(diagnostics)
  child.stdin.on("error", () => {})
  child.stdin.end(readFileSync(join(context.cwd, "prompt.txt")))
  const signal = (name) => {
    try {
      if (process.platform !== "win32") process.kill(-child.pid, name)
      else child.kill(name)
    } catch {}
  }
  child.stdout.on("data", (chunk) => {
    eventBuffer += chunk.toString()
    while (eventBuffer.includes("\n")) {
      const newline = eventBuffer.indexOf("\n")
      const line = eventBuffer.slice(0, newline)
      eventBuffer = eventBuffer.slice(newline + 1)
      try {
        const event = JSON.parse(line)
        if (
          event.type === "item.started" &&
          ["mcp_tool_call", "command_execution"].includes(event.item?.type) &&
          ++actionCalls > 20
        ) {
          callBudgetExceeded = true
          signal("SIGTERM")
        }
      } catch {}
    }
  })
  const deadline = setTimeout(() => {
    timedOut = true
    signal("SIGTERM")
  }, options.timeoutSeconds * 1000)
  const escalation = setTimeout(
    () => {
      if (timedOut || callBudgetExceeded) signal("SIGKILL")
    },
    options.timeoutSeconds * 1000 + 5000,
  )
  const code = await new Promise((resolve) => {
    child.once("error", (caught) => {
      error = caught.message
      resolve(null)
    })
    child.once("close", resolve)
  })
  clearTimeout(deadline)
  clearTimeout(escalation)
  await Promise.all([new Promise((resolve) => events.end(resolve)), new Promise((resolve) => diagnostics.end(resolve))])
  const outcome = {
    context: context.name,
    tasks: context.tasks,
    variant: context.variant,
    mode: context.mode,
    repeat: context.repeat,
    requestedModel: options.model,
    runnerSha256,
    resolvedBackendSnapshot: null,
    runnerVersion: version.stdout.trim(),
    started,
    ended: new Date().toISOString(),
    seconds: (performance.now() - timerStart) / 1000,
    code,
    timedOut,
    callBudgetExceeded,
    actionCalls,
    error,
    finalAnswerPresent: existsSync(join(context.cwd, "final.md")),
    fixtureSha256: manifest.fixtureSha256,
    clock: manifest.clock,
    seed: manifest.seed,
    argv: args,
  }
  writeFileSync(join(context.cwd, "run.json"), JSON.stringify(outcome, null, 2))
  if (code !== 0 || timedOut || callBudgetExceeded || !outcome.finalAnswerPresent) failures++
  console.log(
    JSON.stringify({
      context: context.name,
      code,
      timedOut,
      callBudgetExceeded,
      actionCalls,
      seconds: Math.round(outcome.seconds),
      finalAnswerPresent: outcome.finalAnswerPresent,
    }),
  )
}
await Promise.all(
  Array.from({ length: options.concurrency }, async () => {
    while (cursor < selected.length) await run(selected[cursor++])
  }),
)
console.log(
  JSON.stringify({
    completed: selected.length,
    runnerFailures: failures,
    note: "runner completion is not task correctness; grade traces and final answers separately",
  }),
)
process.exitCode = failures ? 1 : 0
