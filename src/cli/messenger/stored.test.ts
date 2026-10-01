import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Message } from "../../domain/models.js"
import { type MessageStore, openStore } from "../../store/store.js"
import type { MessengerAdapter } from "./port.js"
import { stored } from "./stored.js"

const account = { provider: "test", account: "500" }

const message = (id: string, text: string, chatId = "7"): Message => ({
  id,
  chatId,
  senderId: "500",
  senderName: "Me",
  timestamp: "2026-09-26T10:00:00.000Z",
  editedAt: null,
  text,
  outgoing: true,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const setUp = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "stored-")), "m.db") })
  opened.push(store)
  await store.saveChats(account, [
    { id: "7", title: "Book club", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 3 },
    { id: "8", title: "Olga", kind: "dialog", unreadCount: 0, lastMessageAt: null, participantsCount: 2 },
  ])
  await store.saveMessages(account, "7", [message("1", "the meeting is on tuesday")], { via: "history" })
  const adapter = {
    self: () => "500",
    edit: async (chatId: string, messageId: string, text: string) => message(messageId, text, chatId),
    forward: async () => message("90", "the meeting is on tuesday", "8"),
    delete: async () => {},
  }
  const wrapped = stored(adapter as unknown as MessengerAdapter, {
    account,
    store: async () => store,
    warn: () => {},
    events: () => {},
  })
  const found = async (text: string) => (await store.search(text, { limit: 10, account })).items.map((hit) => hit.id)
  return { wrapped, found }
}

describe("what the writes leave in the store", () => {
  it("an edit replaces the text search finds", async () => {
    const { wrapped, found } = await setUp()

    await wrapped.edit?.("7", "1", "the meeting moved to friday", {})

    expect(await found("tuesday")).toEqual([])
    expect(await found("friday")).toEqual(["1"])
  })

  it("a deletion leaves nothing for search to find", async () => {
    const { wrapped, found } = await setUp()

    await wrapped.delete?.("7", ["1"], { forEveryone: false })

    expect(await found("tuesday")).toEqual([])
  })

  it("a forward keeps its copy in the chat it went to", async () => {
    const { wrapped, found } = await setUp()

    await wrapped.forward?.("7", "1", "8", { sendId: "1" })

    expect(await found("tuesday")).toEqual(["90", "1"])
  })
})
