import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Chat, Message } from "../domain/models.js"
import { type AccountKey, openStore } from "./store.js"

const fresh = () => join(mkdtempSync(join(tmpdir(), "left-")), "messages.db")
const OWNER: AccountKey = { provider: "max", account: "1" }
const OTHER: AccountKey = { provider: "max", account: "2" }

const chat = (id: string): Chat => ({
  id,
  title: `Chat ${id}`,
  kind: "group",
  unreadCount: 0,
  lastMessageAt: null,
  participantsCount: null,
})

const message = (id: string, chatId: string): Message => ({
  id,
  chatId,
  senderId: "7",
  senderName: "Vera",
  timestamp: "2026-09-26T10:00:00.000Z",
  editedAt: null,
  text: "hello",
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const ids = async (store: Awaited<ReturnType<typeof openStore>>, key: AccountKey) =>
  (await store.chats(key, {})).items.map((one) => one.id)

describe("a chat the account left", () => {
  it("is marked by a complete list, skipped by the reads, kept across a reopen, and unmarked on rejoining", async () => {
    const path = fresh()
    const store = await openStore({ path })
    await store.saveChats(OWNER, [chat("-1"), chat("-2")])
    await store.saveMembers(OWNER, "-2", ["7"])

    expect(await store.markChatsLeft(OWNER, ["-1"])).toBe(1)
    expect(await store.markChatsLeft(OWNER, ["-1"])).toBe(0)
    expect(await ids(store, OWNER)).toEqual(["-1"])
    expect(await store.countChats(OWNER)).toBe(1)
    expect(await store.chatsWith(OWNER, "7")).toEqual([])
    await store.close()

    const reopened = await openStore({ path })
    expect(await ids(reopened, OWNER)).toEqual(["-1"])
    await reopened.saveChats(OWNER, [chat("-2")])
    expect((await ids(reopened, OWNER)).sort()).toEqual(["-1", "-2"])
    await reopened.close()
  })

  it("is marked per account", async () => {
    const store = await openStore({ path: fresh() })
    await store.saveChats(OWNER, [chat("-1"), chat("-2")])
    await store.saveChats(OTHER, [chat("-2")])

    await store.markChatsLeft(OWNER, ["-1"])

    expect(await ids(store, OTHER)).toEqual(["-2"])
    await store.close()
  })

  it("is counted, then deleted with its messages and members, and nothing else is", async () => {
    const store = await openStore({ path: fresh() })
    await store.saveChats(OWNER, [chat("-1"), chat("-2")])
    await store.saveMessages(OWNER, "-1", [message("10", "-1")], { via: "history" })
    await store.saveMessages(OWNER, "-2", [message("20", "-2"), message("21", "-2")], { via: "history" })
    await store.saveMembers(OWNER, "-2", ["7"])
    await store.markChatsLeft(OWNER, ["-1"])

    expect(await store.leftChats(OWNER)).toEqual({ chats: 1, messages: 2 })
    expect(await store.leftChats(OWNER, { clear: true })).toEqual({ chats: 1, messages: 2 })
    expect(await store.leftChats(OWNER)).toEqual({ chats: 0, messages: 0 })
    expect(await store.message(OWNER, "20")).toBeUndefined()
    expect(await store.message(OWNER, "10")).toBeDefined()
    expect(await store.members(OWNER, "-2")).toEqual([])
    await store.close()
  })
})
