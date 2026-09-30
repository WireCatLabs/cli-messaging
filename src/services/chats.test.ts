import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { MessengerAdapter } from "../cli/messenger/port.js"
import type { Chat } from "../domain/models.js"
import type { SendGuard } from "../sends/guard.js"
import { type MessageStore, openStore } from "../store/store.js"
import { chatsService } from "./chats.js"
import { onlineDeps, storedDeps } from "./deps.js"
import { peopleService } from "./people.js"

const account = { provider: "test", account: "500" }
const messenger = { provider: "test", chatArgument: "a chat" } as Messenger
const guard = {} as SendGuard

const chatOf = (id: string, title: string, kind: Chat["kind"], unreadCount: number, minute: number): Chat => ({
  id,
  title,
  kind,
  unreadCount,
  lastMessageAt: `2026-09-27T10:0${minute}:00.000Z`,
  participantsCount: kind === "dialog" ? 2 : 4,
})
const chats = [
  chatOf("7", "Book club", "group", 2, 3),
  chatOf("8", "Olga", "dialog", 0, 2),
  chatOf("9", "Anton", "dialog", 1, 1),
]

const opened: MessageStore[] = []
const keptStore = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "services-")), "m.db") })
  opened.push(store)
  await store.saveChats(account, chats)
  return store
}

afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

describe("the chats service", () => {
  it("filters the newest chats online, and says when older ones were not searched", async () => {
    const adapter = { self: () => "500", chats: async () => ({ items: chats, hasMore: true }) }
    const service = chatsService(onlineDeps(messenger, adapter as unknown as MessengerAdapter, guard))

    const found = await service.list({ unread: true }, { limit: 1, offset: 0 })

    expect(found).toEqual({ items: [chats[0]], hasMore: true, partial: true })
  })

  it("filters every stored chat offline", async () => {
    const service = chatsService(storedDeps(messenger, await keptStore(), account, guard))

    const found = await service.list({ kind: "dialog" }, { offset: 0 })

    expect(found.items.map((one) => one.id)).toEqual(["8", "9"])
    expect(found.partial).toBe(false)
  })

  it("refuses the reads only the messenger can answer offline", async () => {
    const service = chatsService(storedDeps(messenger, await keptStore(), account, guard))

    await expect(service.events("7", {})).rejects.toThrow(/`chats events` reads the chat's history/)
    await expect(service.show("7")).rejects.toThrow(/--offline/)
  })
})

describe("the people service", () => {
  it("lists the people of the one-to-one chats kept in the store, by name", async () => {
    const service = peopleService(storedDeps(messenger, await keptStore(), account, guard))

    const found = await service.list({ order: "name", offset: 0 })

    expect(found.items.map((one) => one.name)).toEqual(["Anton", "Olga"])
  })
})
