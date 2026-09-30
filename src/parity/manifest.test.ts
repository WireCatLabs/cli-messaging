import { readFileSync } from "node:fs"
import type { CommandInfo } from "@leemour/cli-core/commands"
import { describe, expect, it } from "vitest"
import { type CommandsJson, type Manifest, manifestProblems, parityProblems } from "./manifest.js"

const shipped: Manifest = JSON.parse(readFileSync(new URL("../../parity.json", import.meta.url), "utf8"))

const command = (path: string, options: string[] = [], commands: CommandInfo[] = []): CommandInfo => ({
  path: path.split(" "),
  name: path.split(" ").at(-1) ?? path,
  description: "",
  usage: "",
  origin: "handwritten",
  arguments: [],
  options: options.map((flags) => ({ flags, description: "", takesValue: false, mandatory: false })),
  commands,
})

const program = (...commands: CommandInfo[]): CommandsJson => ({ cli: "tg", globalOptions: [], commands })

const manifest = (commands: Manifest["commands"]): Manifest => ({
  options: { "--all": { meaning: "every row" }, "--max": { value: "<n>", meaning: "at most" } },
  globalOptions: {},
  commands,
})

describe("the shipped parity.json", () => {
  it("is well-formed", () => {
    expect(manifestProblems(shipped)).toEqual([])
  })
})

describe("manifestProblems", () => {
  it("wants a reason on a one-sided row, a workstream on a planned one, and every option catalogued", () => {
    const problems = manifestProblems(
      manifest({
        chats: { state: "max-only" },
        store: { state: "planned", options: { "--all": "both", "--max": "both", "--nope": "both" } },
      }),
    )

    expect(problems).toEqual([
      "chats: max-only without a reason",
      'store: planned without "by"',
      "store --nope: not in the option catalogue",
    ])
  })

  it("refuses a row that a one-sided row above it already covers", () => {
    const problems = manifestProblems({
      ...manifest({ topics: { state: "tg-only", reason: "MAX has none" }, "topics list": { state: "both" } }),
      options: {},
    })

    expect(problems).toEqual(['topics list: under "topics", which is tg-only and covers it'])
  })
})

describe("parityProblems", () => {
  const rows = manifest({
    store: { state: "both" },
    "store fetch": { state: "both", options: { "--all": "both", "--max": { state: "planned", by: "P1" } } },
    "store jobs": { state: "planned", by: "T6" },
    topics: { state: "tg-only", reason: "MAX has none" },
  })

  it("passes a CLI that has what its column says, planned or not", () => {
    const tg = program(
      command("store", [], [command("store fetch", ["--all", "--max <n>"]), command("store jobs")]),
      command("topics", [], [command("topics list")]),
    )
    const max = program(command("store", [], [command("store fetch", ["--all"])]))

    expect(parityProblems(rows, "tg", tg)).toEqual([])
    expect(parityProblems(rows, "max", max)).toEqual([])
  })

  it("names what is missing from the manifest, from the CLI, and on the wrong side", () => {
    const max = program(
      command("store", [], [command("store fetch", ["--background"]), command("store info")]),
      command("topics"),
    )

    expect(parityProblems(rows, "max", max)).toEqual([
      "store fetch --all: the manifest says both, max lacks it",
      "store fetch --background: not in the manifest — add its row first",
      "store info: not in the manifest — add its row first",
      "topics: max has it, the manifest says tg-only",
    ])
  })
})
