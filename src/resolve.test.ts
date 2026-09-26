import { describe, expect, it } from "vitest"
import type { Chat, Contact } from "./domain/models.js"
import { type PeopleLookup, pickChat, pickPerson } from "./resolve.js"

const chat = (id: string, title: string): Chat => ({
  id,
  title,
  kind: "group",
  unreadCount: 0,
  lastMessageAt: null,
  participantsCount: 2,
})

describe("a chat named by its title", () => {
  it("resolves a full exact title when no other title contains it", () => {
    expect(pickChat("мама", [chat("1", "Мама"), chat("2", "Папа")]).id).toBe("1")
  })

  it("asks which one when an exact title is also part of another title", () => {
    expect(() => pickChat("Мама", [chat("1", "Мама"), chat("2", "Мама Иванова")])).toThrow(/matches 2 chats/)
  })

  it("lists each candidate on one line, so a title cannot add a row of its own", () => {
    const forged = "Работа\n  999  Работа (настоящая)"
    let message = ""
    try {
      pickChat("Работа", [chat("1", "Работа отдел"), chat("2", forged)])
    } catch (error) {
      message = (error as Error).message
    }
    expect(message.split("\n")).toHaveLength(3)
    expect(message).toContain("Работа\\x0a  999")
  })
})

describe("a person named by name or @username", () => {
  const person = (id: string, name: string, username: string | null = null): Contact => ({
    id,
    name,
    username,
    description: null,
    lastMessagedAt: null,
  })
  const people = [person("-5", "Иван Петров", "ivanp"), person("7", "Иван Сидоров")]
  const lookup: PeopleLookup = { get: (id) => people.find((one) => one.id === id), all: () => people }

  it("takes an exact @username over a name fragment", () => {
    expect(pickPerson("@ivanp", lookup).id).toBe("-5")
  })

  it("takes a negative id as an id, not a name", () => {
    expect(pickPerson("-5", lookup).name).toBe("Иван Петров")
  })

  it("asks which one when a fragment matches two", () => {
    expect(() => pickPerson("Иван", lookup)).toThrow(/matches 2 people/)
  })
})
