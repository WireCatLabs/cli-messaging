import { describe, expect, it, vi } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { MessengerAdapter } from "../cli/messenger/port.js"
import type { GuardRequest, SendGuard } from "../sends/guard.js"
import type { SendEntry } from "../sends/journal.js"
import { adminService } from "./admin.js"
import { onlineDeps } from "./deps.js"

const chat = { id: "-1007", title: "synthetic group", kind: "group" as const }

const fixture = (capable = true) => {
  const records: Omit<SendEntry, "at" | "profile">[] = []
  const checked: GuardRequest[] = []
  const guard = {
    check: (attempt: GuardRequest) => checked.push(attempt),
    record: (entry) => records.push(entry),
  } as SendGuard
  const createInviteLink = vi.fn(async (_chatId: string, options: { approval: boolean; maxUses?: number }) => ({
    link: "https://t.me/+synthetic",
    approval: options.approval,
    expiresAt: null,
    maxUses: options.maxUses ?? null,
  }))
  const adapter = {
    resolve: async () => chat,
    ...(capable ? { createInviteLink } : {}),
  } as unknown as MessengerAdapter
  const deps = onlineDeps({ provider: "test" } as Messenger, adapter, guard)
  return { service: adminService(deps), deps, createInviteLink, records, checked }
}

describe("another invite link", () => {
  it("is made through the guard with approval, an expiry as an ISO minute and a use limit", async () => {
    const f = fixture()
    const made = await f.service.createLink("synthetic group", { approval: true, expires: "7d", maxUses: 5 })
    expect(made).toMatchObject({ chatId: "-1007", link: "https://t.me/+synthetic", approval: true, maxUses: 5 })
    const [, options] = f.createInviteLink.mock.calls[0] ?? []
    expect(options).toMatchObject({ approval: true, maxUses: 5, expiresAt: expect.stringMatching(/:00\.000Z$/) })
    expect(f.checked).toEqual([expect.objectContaining({ chatId: "-1007", kind: "chat", action: "link.create" })])
    expect(f.records).toMatchObject([{ action: "link.create", outcome: "sent" }])
  })

  it("passes no expiry or limit when none is given", async () => {
    const f = fixture()
    await f.service.createLink("synthetic group", { approval: false })
    expect(f.createInviteLink).toHaveBeenCalledWith("-1007", { approval: false })
  })

  it.each([
    [{ maxUses: 0 }, "--max-uses takes a whole number from 1 to 99999"],
    [{ maxUses: 100_000 }, "--max-uses takes a whole number from 1 to 99999"],
    [{ expires: "soon" }, "--expire-time takes a time like"],
    [{ expires: "2020-01-01T00:00" }, "--expire-time has to be at least a minute from now"],
  ])("refuses %j before connecting", async (options, message) => {
    const f = fixture()
    const connection = vi.fn(f.deps.connection)
    const service = adminService({ ...f.deps, connection })
    await expect(service.createLink("synthetic group", { approval: false, ...options })).rejects.toThrow(message)
    expect(connection).not.toHaveBeenCalled()
  })

  it("is refused offline, and by a messenger without extra links, recording nothing", async () => {
    const f = fixture()
    await expect(
      adminService({ ...f.deps, offline: true }).createLink("synthetic group", { approval: true }),
    ).rejects.toThrow("not with --offline")
    await expect(fixture(false).service.createLink("synthetic group", { approval: true })).rejects.toThrow(
      "cannot make another invite link",
    )
    expect(f.records).toEqual([])
  })
})
