import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { defaultRules, ModerationRules } from "./rules.js"

const fresh = () => new ModerationRules(join(mkdtempSync(join(tmpdir(), "max-rules-")), "rules.json"))

describe("ModerationRules", () => {
  it("writes every rule with its default on the first change, then the change", () => {
    const rules = fresh()

    const saved = rules.set("-1", "Team", "invites", "delete")

    expect(saved).toEqual({ ...defaultRules("Team"), invites: "delete" })
    expect(JSON.parse(readFileSync(rules.path, "utf8")).groups["-1"].consent).toEqual({
      delete: "ask",
      remove: "ask",
    })
    expect(saved.newAccount).toEqual({ days: 7, action: "report" })
  })

  it("**reads max-cli's first words** — forbid, flag, confirm — as levels, and drops join-request rules", () => {
    const rules = fresh()
    const old = {
      ...defaultRules("Team"),
      requests: "both",
      consent: { delete: "flag", remove: "forbid", accept: "allow", decline: "allow" },
    }
    writeFileSync(rules.path, JSON.stringify({ groups: { "-1": old } }))

    expect(rules.read("-1")).toEqual({ ...defaultRules("Team"), consent: { delete: "ask", remove: "deny" } })
    rules.set("-1", "Team", "links", "delete")
    const written = JSON.parse(readFileSync(rules.path, "utf8")).groups["-1"]
    expect(written.requests).toBeUndefined()
    expect(written.consent).toEqual({ delete: "ask", remove: "deny" })
  })

  it("reads lists and numbers from text, and puts a rule back with unset", () => {
    const rules = fresh()

    expect(rules.set("-1", null, "trusted", "30000003, 30000004").trusted).toEqual(["30000003", "30000004"])
    expect(rules.set("-1", null, "flood.messages", "10").flood).toEqual({ messages: 10, minutes: 1, action: "report" })
    expect(rules.set("-1", null, "consent.remove", "readonly").consent.remove).toBe("readonly")
    expect(rules.unset("-1", null, "consent.remove").consent.remove).toBe("ask")
    expect(rules.read("-1")?.trusted).toEqual(["30000003", "30000004"])
  })

  it("refuses an unknown rule or a value it does not take, and writes nothing", () => {
    const rules = fresh()

    expect(() => rules.set("-1", null, "spam", "delete")).toThrow(/no rule spam — one of: trusted/)
    expect(() => rules.set("-1", null, "consent.delete", "sometimes")).toThrow(/deny\|readonly\|ask\|allow/)
    expect(() => rules.set("-1", null, "flood.minutes", "0")).toThrow(/1 or more/)
    expect(() => rules.set("-1", null, "blocked", "Bob")).toThrow(/person ids/)
    expect(rules.read("-1")).toBeUndefined()
  })

  it("refuses a hand-edited file that does not check out, naming where", () => {
    const rules = fresh()
    rules.set("-1", null, "links", "delete")
    const edited = JSON.parse(readFileSync(rules.path, "utf8"))
    edited.groups["-1"].links = "ban"
    writeFileSync(rules.path, JSON.stringify(edited))

    expect(() => rules.read("-1")).toThrow(/groups\.-1\.links/)
  })
})
