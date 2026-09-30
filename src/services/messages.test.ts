import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { MessengerAdapter } from "../cli/messenger/port.js"
import type { Chat, Message } from "../domain/models.js"
import type { SendGuard } from "../sends/guard.js"
import { type MessageStore, openStore } from "../store/store.js"
import { onlineDeps, storedDeps } from "./deps.js"
import { messagesService } from "./messages.js"

const account = { provider: "test", account: "500" }
const messenger = { provider: "test", chatArgument: "a chat" } as Messenger
const guard = {} as SendGuard

const chat: Chat = {
  id: "7",
  title: "Book club",
  kind: "group",
  unreadCount: 0,
  lastMessageAt: "2026-09-27T10:02:00.000Z",
  participantsCount: 4,
}

const thread: Message[] = ["1", "2", "3"].map((id, index) => ({
  id,
  chatId: "7",
  senderId: "9",
  senderName: "Olga",
  timestamp: `2026-09-27T10:0${index}:00.000Z`,
  editedAt: null,
  text: `chapter ${id}`,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
}))

const asked: unknown[] = []
const adapter = {
  self: () => "500",
  history: async (reference: string, window: unknown) => {
    asked.push({ reference, window })
    return { items: thread, hasMore: false }
  },
  around: async () => thread.slice(1, 2).map((one) => ({ ...one, anchor: true as const })),
} as unknown as MessengerAdapter

const opened: MessageStore[] = []
const keptStore = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "services-")), "m.db") })
  opened.push(store)
  await store.saveChats(account, [chat])
  await store.saveMessages(account, "7", thread, { via: "history" })
  return store
}

afterEach(async () => {
  asked.length = 0
  for (const store of opened.splice(0)) await store.close()
})

describe("the messages service", () => {
  it("reads a chat from the messenger when online, as it was asked", async () => {
    const page = await messagesService(onlineDeps(messenger, adapter, guard)).list("Book", { limit: 2, before: "3" })

    expect(page.items.map((one) => one.id)).toEqual(["1", "2", "3"])
    expect(asked).toEqual([{ reference: "Book", window: { limit: 2, before: "3" } }])
  })

  it("reads the same chat from the store when offline, found by its title, without connecting", async () => {
    const service = messagesService(storedDeps(messenger, await keptStore(), account, guard))

    const page = await service.list("book", { limit: 2 })
    const around = await service.around("7", "2", { before: 1, after: 0 })

    expect(page.items.map((one) => one.id)).toEqual(["2", "3"])
    expect(around.map((one) => one.id)).toEqual(["1", "2"])
    expect(asked).toEqual([])
  })

  it("refuses to read forward offline, and online when the messenger cannot", async () => {
    const offline = messagesService(storedDeps(messenger, await keptStore(), account, guard))
    const online = messagesService(onlineDeps(messenger, adapter, guard))
    const after = { id: "1" }

    await expect(offline.list("7", { limit: 5, after })).rejects.toThrow(/the store pages only backwards/)
    await expect(online.list("7", { limit: 5, after })).rejects.toThrow(/read forward from a message/)
  })

  it("searches only the store, and never asks the messenger", async () => {
    const found = await messagesService(storedDeps(messenger, await keptStore(), account, guard)).search({
      text: "chapter",
      chat: "Book club",
      limit: 10,
    })

    expect(found.items.map((one) => one.id).sort()).toEqual(["1", "2", "3"])
    expect(asked).toEqual([])
  })
})
