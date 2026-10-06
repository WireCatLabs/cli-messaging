import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { MessengerAdapter } from "../cli/messenger/port.js"
import type { GroupMember } from "../domain/models.js"
import type { SendGuard } from "../sends/guard.js"
import { type MessageStore, openStore } from "../store/store.js"
import { chatsService } from "./chats.js"
import { type ServiceDeps, storedDeps } from "./deps.js"

const account = { provider: "test", account: "500" }
const messenger = { provider: "test", chatArgument: "a chat", app: { command: "chat" } } as Messenger
const guard = {} as SendGuard
const member = (id: string): GroupMember => ({ id, name: `Member ${id}`, username: null, role: "member" })

const opened: MessageStore[] = []
const heldStore = async (participantsCount: number | null) => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "members-fetch-")), "m.db") })
  opened.push(store)
  await store.saveChats(account, [
    { id: "7", title: "Club", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount },
  ])
  return store
}

const pages: unknown[] = []
const listing = (everyone: GroupMember[]) =>
  ({
    self: () => "500",
    members: async (_chat: string, { limit = 200, offset }: { limit?: number; offset: number }) => {
      pages.push(offset)
      return { chatId: "7", items: everyone.slice(offset, offset + limit), hasMore: offset + limit < everyone.length }
    },
  }) as unknown as MessengerAdapter

const online = (store: MessageStore, adapter: MessengerAdapter): ServiceDeps => ({
  ...storedDeps(messenger, store, account, guard),
  offline: false,
  connection: async () => adapter,
})

afterEach(async () => {
  pages.length = 0
  for (const store of opened.splice(0)) await store.close()
})

describe("chats members fetch", () => {
  it("records who left only when the whole list was read and the chat's count agrees", async () => {
    const store = await heldStore(2)
    const service = (everyone: GroupMember[]) => chatsService(online(store, listing(everyone)))
    await service([member("21"), member("22")]).fetchMembers("7", { pauseMs: 0 })
    await store.saveChats(account, [
      { id: "7", title: "Club", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 1 },
    ])

    const fetched = await service([member("21")]).fetchMembers("Club", { pauseMs: 0, track: true })

    expect(fetched).toMatchObject({
      chatId: "7",
      read: 1,
      participants: 1,
      complete: true,
      gone: ["22"],
      tracked: true,
    })
    expect((await store.trackedChats(account)).map(({ chatId }) => chatId)).toEqual(["7"])
  })

  it("records nobody as gone when the chat's count is unknown or the budget cut the list", async () => {
    const unknown = await heldStore(null)
    await chatsService(online(unknown, listing([member("21"), member("22")]))).fetchMembers("7", { pauseMs: 0 })
    expect(
      await chatsService(online(unknown, listing([member("21")]))).fetchMembers("7", { pauseMs: 0 }),
    ).toMatchObject({ complete: false, gone: [] })

    const big = Array.from({ length: 450 }, (_, index) => member(String(1000 + index)))
    const cut = await chatsService(online(await heldStore(450), listing(big))).fetchMembers("7", {
      budget: 2,
      pauseMs: 0,
    })
    expect(cut).toMatchObject({ read: 400, more: true, complete: false, tracked: false })
  })

  it("is refused offline", async () => {
    const deps = storedDeps(messenger, await heldStore(1), account, guard)
    await expect(chatsService(deps).fetchMembers("7", {})).rejects.toMatchObject({ code: "validation_error" })
  })
})

describe("chats tracking", () => {
  it("adds, shows and removes a chat from the store alone, keeping its counts", async () => {
    const store = await heldStore(1)
    await chatsService(online(store, listing([member("21")]))).fetchMembers("7", { pauseMs: 0 })
    const service = chatsService(storedDeps(messenger, store, account, guard))

    expect(await service.track("Club", true)).toEqual({ chatId: "7", tracked: true })
    expect(await service.trackedChat("7")).toMatchObject({
      chatId: "7",
      trackedAt: expect.any(String),
      counts: [{ participants: 1, listed: 1, complete: true }],
    })
    await service.track("7", false)
    expect(await service.tracked()).toEqual([])
    expect((await service.trackedChat("7")).counts).toHaveLength(1)
  })
})
