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
  const adapter = { resolve: async () => chat, ...(capable ? { editTopic } : {}) } as unknown as MessengerAdapter
  const deps = onlineDeps({ provider: "test" } as Messenger, adapter, guard)
  return { service: topicsService(deps), deps, editTopic, records, checked }
}

describe("editing a forum topic", () => {
  it.each([
    [{ title: "renamed synthetic topic" }, "topic-edit"],
    [{ closed: true }, "topic-close"],
    [{ closed: false }, "topic-reopen"],
    [{ title: "renamed synthetic topic", closed: true }, "topic-edit"],
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
