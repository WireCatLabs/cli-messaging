import { describe, expect, it } from "vitest"
import { fromOldSettings, levelFor } from "./permissions.js"

describe("the level of a command path", () => {
  it("**takes the most specific key the owner set**, and allows a path nothing names", () => {
    const levels = { messages: "readonly", "messages.send": "allow" } as const

    expect(levelFor(levels, "messages.send").level).toBe("allow")
    expect(levelFor(levels, "messages.edit")).toEqual({ level: "readonly", key: "messages" })
    expect(levelFor(levels, "contacts.add")).toEqual({ level: "allow", key: null })
  })

  it("**lets a built-in default only tighten** a broader key of the owner's", () => {
    expect(levelFor({ messages: "readonly" }, "messages.delete").level).toBe("readonly")
    expect(levelFor({ messages: "allow" }, "messages.delete").level).toBe("ask")
    expect(levelFor({ "messages.delete": "allow" }, "messages.delete").level).toBe("allow")
  })

  it("**reads `allow` as before**: the rest read-only, and a deletion still asking", () => {
    const levels = fromOldSettings(false, ["send", "delete"])

    expect(levelFor(levels, "messages.send").level).toBe("allow")
    expect(levelFor(levels, "messages.delete").level).toBe("ask")
    expect(levelFor(levels, "contacts.add").level).toBe("readonly")
    expect(fromOldSettings(false, undefined)).toEqual({})
  })
})
