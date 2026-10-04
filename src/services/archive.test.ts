import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { MessengerAdapter } from "../cli/messenger/port.js"
import type { Chat, Message } from "../domain/models.js"
import type { SendGuard } from "../sends/guard.js"
import { fetchedKey, historyStartKey, type MessageStore, openStore } from "../store/store.js"
import { archiveService } from "./archive.js"
import type { ServiceDeps } from "./deps.js"
import { storedDeps } from "./deps.js"
import { inboxService } from "./inbox.js"

const account = { provider: "test", account: "500" }
const messenger = { provider: "test", chatArgument: "a chat" } as Messenger
const guard = {} as SendGuard

const chat: Chat = {
  id: "7",
  title: "Book club",
  kind: "group",
  unreadCount: 0,
  lastMessageAt: "2026-09-27T10:05:00.000Z",
  participantsCount: 4,
}

const messageAt = (id: number): Message => ({
  id: String(id),
  chatId: "7",
  senderId: "9",
  senderName: "Olga",
  timestamp: new Date(Date.parse("2026-09-27T10:00:00.000Z") + id * 60_000).toISOString(),
  editedAt: null,
  text: `chapter ${id}`,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const opened: MessageStore[] = []
const emptyStore = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "services-")), "m.db") })
  opened.push(store)
  await store.saveChats(account, [chat])
  return store
}

afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

describe("the archive service", () => {
  it("fetches a chat page by page into the store, then reads it back out oldest first", async () => {
    const store = await emptyStore()
    const history = [1, 2, 3, 4, 5].map(messageAt)
    const adapter = {
      self: () => "500",
      history: async (_chat: string, { limit, before }: { limit: number; before?: string }) => {
        const older = history.filter((one) => before === undefined || Number(one.id) < Number(before))
        const items = older.slice(-limit)
        await store.saveMessages(account, "7", items, { via: "history" })
        return { items, hasMore: older.length > items.length }
      },
    } as unknown as MessengerAdapter
    const deps: ServiceDeps = {
      ...storedDeps(messenger, store, account, guard),
      offline: false,
      connection: async () => adapter,
    }
    const service = archiveService(deps)

    const fetched = await service.fetch("Book club", {
      limit: 1000,
      pageSize: 100,
      pauseMs: 0,
      note: () => {},
      stop: new AbortController().signal,
      onPage: () => {},
    })
    const exported = await service.export("book club")

    expect(fetched).toMatchObject({ chat: "7", fetched: 5, complete: true, ranges: [{ from: 1, to: 5 }] })
    expect(exported.title).toBe("Book club")
    expect(exported.messages.map((one) => one.id)).toEqual(["1", "2", "3", "4", "5"])
    expect(await service.held("7")).toEqual([{ from: 1, to: 5 }])
    expect(await store.syncState(account, historyStartKey("7"))).toMatchObject({ value: "1" })
    expect(await store.syncState(account, fetchedKey("7"))).toMatchObject({ value: "5" })
  })
})

describe("the inbox service", () => {
  it("refuses offline, before anything is opened", async () => {
    const service = inboxService(storedDeps(messenger, await emptyStore(), account, guard))

    await expect(service.read({ limit: 20 })).rejects.toThrow(/`inbox` asks the messenger/)
    await expect(service.review({ since: 0 })).rejects.toThrow(/`review` asks the messenger/)
  })
})
