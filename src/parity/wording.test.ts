import type { CommandInfo } from "@leemour/cli-core/commands"
import { describe, expect, it } from "vitest"
import type { CommandsJson, Manifest } from "./manifest.js"
import { wordingProblems } from "./wording.js"

const program = (cli: string, pause: string): CommandsJson => {
  const fetch: CommandInfo = {
    path: ["store", "fetch"],
    name: "fetch",
    description: "",
    usage: "",
    origin: "handwritten",
    arguments: [],
    options: [{ flags: "--pause <duration>", description: pause, takesValue: true, mandatory: false }],
    commands: [],
  }
  return { cli, globalOptions: [], commands: [fetch] }
}

const manifest = (note?: string): Manifest => ({
  options: { "--pause": { value: "<duration>", meaning: "wait", ...(note ? { note } : {}) } },
  globalOptions: {},
  commands: { store: { state: "both" }, "store fetch": { state: "both", options: { "--pause": "both" } } },
})

describe("one sentence per shared option", () => {
  it("names a shared option the two tools describe differently", () => {
    expect(wordingProblems(manifest(), program("max", "wait"), program("tg", "pause"))).toEqual([
      'store fetch --pause: max says "wait", tg says "pause"',
    ])
  })

  it("passes the same sentence, and leaves a clash the catalogue already notes", () => {
    expect(wordingProblems(manifest(), program("max", "wait"), program("tg", "wait"))).toEqual([])
    expect(
      wordingProblems(manifest("max's own copy until T6"), program("max", "wait"), program("tg", "pause")),
    ).toEqual([])
  })
})
