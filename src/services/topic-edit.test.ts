import { describe, expect, it, vi } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { MessengerAdapter } from "../cli/messenger/port.js"
import type { GuardRequest, SendGuard } from "../sends/guard.js"
import type { SendEntry } from "../sends/journal.js"
import { onlineDeps } from "./deps.js"
import { topicsService } from "./topics.js"

const chat = { id: "7", title: "synthetic group", kind: "group" as const }
const topic = {
  id: "12",
  title: "renamed synthetic topic",
  closed: true,
  pinned: false,
  unreadCount: 0,
  lastMessageAt: null,
  createdAt: null,
}

const fixture = (capable = true) => {
  const records: Omit<SendEntry, "at" | "profile">[] = []
  const checked: GuardRequest[] = []
  const guard = {
    check: (request: GuardRequest) => checked.push(request),
    record: (entry) => records.push(entry),
  } as SendGuard
  const editTopic = vi.fn(async () => topic)
  const orderPinnedTopics = vi.fn(async () => {})
  const adapter = {
    resolve: async () => chat,
    ...(capable ? { editTopic, orderPinnedTopics } : {}),
  } as unknown as MessengerAdapter
  const deps = onlineDeps({ provider: "test" } as Messenger, adapter, guard)
  return { service: topicsService(deps), deps, editTopic, orderPinnedTopics, records, checked }
}

describe("editing a forum topic", () => {
  it.each([
    [{ title: "renamed synthetic topic" }, "topic-edit"],
    [{ closed: true }, "topic-close"],
    [{ closed: false }, "topic-reopen"],
    [{ title: "renamed synthetic topic", closed: true }, "topic-edit"],
    [{ pinned: true }, "topic-pin"],
    [{ pinned: false }, "topic-unpin"],
    [{ closed: true, pinned: true }, "topic-edit"],
    [{ hidden: true }, "topic-hide"],
    [{ hidden: false }, "topic-unhide"],
  ] as const)("passes %j and journals %s with the topic id, never the title", async (change, action) => {
    const f = fixture()
    expect(await f.service.edit("synthetic group", " 12 ", change)).toMatchObject({ chatId: "7", topic })
    expect(f.editTopic).toHaveBeenCalledWith("7", "12", change)
    expect(f.checked[0]).toMatchObject({ kind: "chat", action, key: "topics.edit", threadId: "12" })
    expect(f.records).toMatchObject([{ action, threadId: "12", outcome: "sent" }])
    expect(JSON.stringify(f.records)).not.toContain("renamed")
  })

  it.each([
    [{}, "nothing to change"],
    [{ title: " " }, "1–128 UTF-8 bytes"],
    [{ title: "x".repeat(129) }, "1–128 UTF-8 bytes"],
  ])("refuses %j before connecting", async (change, message) => {
    const f = fixture()
    const connection = vi.fn(f.deps.connection)
    await expect(topicsService({ ...f.deps, connection }).edit("7", "12", change)).rejects.toThrow(message)
    expect(connection).not.toHaveBeenCalled()
  })

  it("refuses a blank topic, offline, and a messenger without topics", async () => {
    await expect(fixture().service.edit("7", " ", { closed: true })).rejects.toThrow("which topic")
    const offline = fixture()
    await expect(topicsService({ ...offline.deps, offline: true }).edit("7", "12", { closed: true })).rejects.toThrow(
      "not with --offline",
    )
    await expect(fixture(false).service.edit("7", "12", { closed: true })).rejects.toThrow("cannot edit forum topics")
  })
})

describe("ordering pinned topics", () => {
  it("passes the ids in order and journals topic-order", async () => {
    const f = fixture()
    expect(await f.service.order("synthetic group", [" 12", "3 "])).toMatchObject({ chatId: "7", order: ["12", "3"] })
    expect(f.orderPinnedTopics).toHaveBeenCalledWith("7", ["12", "3"])
    expect(f.records).toMatchObject([{ action: "topic-order", outcome: "sent" }])
  })

  it.each([[[]], [["12", " "]], [["12", "12"]]])("refuses %j before connecting", async (order) => {
    const f = fixture()
    const connection = vi.fn(f.deps.connection)
    await expect(topicsService({ ...f.deps, connection }).order("7", order)).rejects.toMatchObject({
      code: "validation_error",
    })
    expect(connection).not.toHaveBeenCalled()
  })

  it("refuses a messenger without the capability", async () => {
    await expect(fixture(false).service.order("7", ["12"])).rejects.toThrow("cannot order pinned forum topics")
  })
})
