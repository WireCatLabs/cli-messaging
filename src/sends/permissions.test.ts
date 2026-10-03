import { describe, expect, it } from "vitest"
import { fromOldSettings, keyForCommand, levelFor } from "./permissions.js"

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

describe("a bot's permissions", () => {
  it("**keys every bot command under `bot`**, apart from its housekeeping", () => {
    expect(keyForCommand(["bot", "messages", "send"])).toBe("bot.messages.send")
    expect(keyForCommand(["bot", "chats", "members", "remove"])).toBe("bot.chats.members.remove")
    expect(keyForCommand(["bot", "watch"])).toBe("bot.messages")
    expect(keyForCommand(["bot", "commands", "set"])).toBe("bot.commands.set")
    expect(keyForCommand(["bot", "api", "send-message"])).toBe("bot.api.send-message")
    expect(keyForCommand(["bot", "auth", "set"])).toBeNull()
    expect(keyForCommand(["bot", "recipients", "add"])).toBeNull()
  })

  it("**reads a bot's old `allow` as the bot's own keys**, leaving the personal account alone", () => {
    const levels = fromOldSettings(false, ["send", "profile", "delete"], { bot: true })

    expect(levelFor(levels, "bot.messages.send").level).toBe("allow")
    expect(levelFor(levels, "bot.commands.set").level).toBe("allow")
    expect(levelFor(levels, "bot.messages.delete").level).toBe("ask")
    expect(levelFor(levels, "bot.webhooks.set").level).toBe("readonly")
    expect(levelFor(levels, "messages.send").level).toBe("allow")
    expect(fromOldSettings(true, undefined, { bot: true })).toEqual({ bot: "readonly" })
  })

  it("**asks before a bot deletes**, as the personal account does", () => {
    expect(levelFor({}, "bot.messages.delete").level).toBe("ask")
  })
})

it("maps legacy groups to forum configuration and creation", () => {
  const result = fromOldSettings(false, ["groups"])
  expect(result["topics.enable"]).toBe("ask")
  expect(result["topics.create"]).toBe("allow")
})

it("preserves old pin permission for unpin and keeps an explicit unpin override", () => {
  const personal = fromOldSettings(false, ["pin"])
  const bot = fromOldSettings(false, ["pin"], { bot: true })
  expect(levelFor(personal, "messages.unpin").level).toBe("allow")
  expect(levelFor(bot, "bot.messages.unpin").level).toBe("allow")
  expect(levelFor({ ...personal, "messages.unpin": "deny" }, "messages.unpin").level).toBe("deny")
})
