import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const fixture = fileURLToPath(new URL("stats-fixture.mjs", import.meta.url))
const invoke = (root, args, overrides = {}) =>
  spawnSync(process.execPath, [fixture, ...args], {
    env: {
      ...process.env,
      STATS_EVAL_ROOT: root,
      STATS_EVAL_CLOCK: "2026-10-08T12:00:00Z",
      STATS_EVAL_SEED: "repro-check",
      ...overrides,
    },
    encoding: "utf8",
    timeout: 30000,
  })
const roots = Array.from({ length: 2 }, () => mkdtempSync(join(tmpdir(), "stats-clock-check-")))
const args = ["stats", "messages", "counters", "show", "--chat", "9", "--json"]
const first = invoke(roots[0], args),
  second = invoke(roots[1], args)
assert.equal(first.status, 0)
assert.equal(second.status, 0)
assert.equal(first.stdout, second.stdout)
assert.equal(JSON.parse(first.stdout).cutoff, "2026-10-08T12:00:00.000Z")
const shown = JSON.parse(first.stdout)
const selection = JSON.stringify({
  ...shown.selection,
  locators: shown.selection.locators.filter((one) => one.endsWith("/p10")),
})
assert.equal(
  invoke(roots[0], [
    "stats",
    "messages",
    "counters",
    "refresh",
    "--selection",
    selection,
    "--counters",
    "views,reactions",
    "--max-messages",
    "1",
    "--sync-time",
    "5s",
    "--json",
  ]).status,
  0,
)
assert.equal(invoke(roots[1], args).stdout, second.stdout)
assert.notEqual(invoke(roots[0], args).stdout, first.stdout)
assert.notEqual(invoke(roots[0], ["__seed"], { STATS_EVAL_CLOCK: "2026-10-09T12:00:00Z" }).status, 0)
assert.notEqual(invoke(roots[0], ["__seed"], { STATS_EVAL_SEED: "different" }).status, 0)
const seed = JSON.parse(readFileSync(join(roots[0], "seed.json"), "utf8"))
assert.equal(seed.clock, Date.parse("2026-10-08T12:00:00Z"))
assert.equal(seed.seed, "repro-check")
console.log(
  JSON.stringify({
    passed: true,
    checks: "byte-identical fixed-clock reads; mutation isolation; clock/seed mismatch refusal",
    roots,
  }),
)
