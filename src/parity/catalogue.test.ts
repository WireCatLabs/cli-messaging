import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { renderCatalogue, withCatalogue } from "./catalogue.js"

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8")

describe("the option catalogue", () => {
  it("in STANDARD.md is the one parity.json renders — run pnpm parity:render", () => {
    const page = read("docs/dev/STANDARD.md")

    expect(page).toBe(withCatalogue(page, renderCatalogue(JSON.parse(read("parity.json")))))
  })

  it("lists an option once, with every command that takes it and how", () => {
    const table = renderCatalogue({
      clis: ["max", "tg"],
      options: { "--max": { value: "<n>", meaning: "at most n", note: "clash with --last" } },
      globalOptions: {},
      commands: {
        store: { in: "all" },
        "store fetch": { in: "all", options: { "--max": { in: ["tg"], planned: { max: "P1" } } } },
      },
    })

    expect(table).toContain("| `--max` | `<n>` | at most n. **clash with --last** |  | `store fetch` (planned) |")
  })

  it("refuses a page without the markers", () => {
    expect(() => withCatalogue("# no table here", "")).toThrow(/markers/)
  })
})
