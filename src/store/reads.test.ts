import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Chat, Message } from "../domain/models.js"
import { type AccountKey, openStore } from "./store.js"

const fresh = () => join(mkdtempSync(join(tmpdir(), "reads-")), "messages.db")
const OWNER: AccountKey = { provider: "max", account: "1" }
const OTHER: AccountKey = { provider: "max", account: "2" }

const chat = (id: string, title: string, kind: Chat["kind"], unreadCount: number, lastMessageAt: string): Chat => ({
  id,
  title,
  kind,
  unreadCount,
  lastMessageAt,
  participantsCount: null,
})

const at = (minute: number) => new Date(Date.UTC(2026, 8, 30, 10, minute)).toISOString()

const message = (id: string, minute: number): Message => ({
  id,
  chatId: "-1",
  senderId: "7",
  senderName: "Ana",
  timestamp: at(minute),
  editedAt: null,
  text: `message ${id}`,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

describe("filtered chat lists", () => {
  it("**filter by title, kind and unread, and count the same filter**", async () => {
    const store = await openStore({ path: fresh() })
    await store.saveChats(OWNER, [
      chat("-1", "Valencia expats", "group", 3, at(5)),
      chat("-2", "València runners", "group", 0, at(9)),
      chat("7", "Ana", "dialog", 1, at(7)),
    ])
    await store.saveChats(OTHER, [chat("-3", "Valencia market", "group", 2, at(1))])
    const ids = async (filter: Parameters<typeof store.chats>[1]) =>
      (await store.chats(OWNER, filter)).items.map(({ id }) => id)

    expect(await ids({ query: "lencia" })).toEqual(["-1"])
    expect(await ids({ kind: "group" })).toEqual(["-2", "-1"])
    expect(await ids({ unread: true })).toEqual(["7", "-1"])
    expect(await ids({ kind: "group", unread: true, limit: 5 })).toEqual(["-1"])
    expect(await store.countChats(OWNER, { unread: true })).toBe(2)
    expect(await store.countChats(OWNER)).toBe(3)
    expect(await store.countChats(OTHER, { query: "lencia" })).toBe(1)
    await expect(store.chats(OWNER, { query: "va" })).rejects.toMatchObject({ code: "validation_error" })
    await store.close()
  })
})

describe("messages by time", () => {
  const seeded = async () => {
    const store = await openStore({ path: fresh() })
    await store.saveMessages(
      OWNER,
      "-1",
      [1, 2, 3, 4, 5].map((n) => message(String(n), n * 10)),
      { via: "history" },
    )
    await store.markDeleted(OWNER, ["3"], { chatId: "-1" })
    return store
  }
  const ids = (messages: Message[]) => messages.map(({ id }) => id)

  it("**a window around a moment**: some at or before it, some after, oldest first, deleted left out", async () => {
    const store = await seeded()

    expect(ids(await store.messagesWindow(OWNER, "-1", { at: at(30), before: 2, after: 2 }))).toEqual([
      "1",
      "2",
      "4",
      "5",
    ])
    expect(ids(await store.messagesWindow(OWNER, "-1", { at: at(20), before: 1, after: 1 }))).toEqual(["2", "4"])
    expect(await store.messagesWindow(OTHER, "-1", { at: at(30), before: 5, after: 5 })).toEqual([])
    await store.close()
  })

  it("pages and counts the messages sent since a moment", async () => {
    const store = await seeded()

    const page = await store.messages(OWNER, "-1", { limit: 1, since: at(20) })
    expect(ids(page.items)).toEqual(["5"])
    expect(page.hasMore).toBe(true)
    expect(ids((await store.messages(OWNER, "-1", { limit: 10, since: at(20) })).items)).toEqual(["2", "4", "5"])
    expect(await store.countMessages(OWNER, "-1", { since: at(20) })).toBe(3)
    expect(await store.countMessages(OWNER, "-1")).toBe(4)
    expect(await store.countMessages(OTHER, "-1")).toBe(0)
    await store.close()
  })
})
