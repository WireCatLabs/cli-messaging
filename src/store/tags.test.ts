import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Chat, Message } from "../domain/models.js"
import { searchStore, statsStore } from "../services/messages.js"
import { openCache } from "./open.js"
import { type AccountKey, type MessageStore, openStore } from "./store.js"

const OWNER: AccountKey = { provider: "tg", account: "1" }
const OTHER: AccountKey = { provider: "tg", account: "2" }
const fresh = () => join(mkdtempSync(join(tmpdir(), "tags-")), "messages.db")

const chat = (id: string): Chat => ({
  id,
  title: `Chat ${id}`,
  kind: "group",
  unreadCount: 0,
  lastMessageAt: null,
  participantsCount: null,
})
const message = (id: string, chatId: string, senderId: string | null, text: string): Message => ({
  id,
  chatId,
  senderId,
  senderName: senderId === null ? null : `Person ${senderId}`,
  timestamp: new Date(Date.UTC(2026, 0, 1, 10, Number(id))).toISOString(),
  editedAt: null,
  text,
  outgoing: senderId === null,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const live: MessageStore[] = []
afterEach(async () => {
  for (const store of live.splice(0)) await store.close()
})

/** Chat 1: messages 1 (from 7), 2 (from 8), 3 (sent by the owner, no sender). Chat 2: message 4 (from 8). */
const seeded = async (path = fresh()) => {
  const store = await openStore({ path })
  live.push(store)
  await store.saveChats(OWNER, [chat("1"), chat("2")])
  await store.saveMessages(
    OWNER,
    "1",
    [
      message("1", "1", "7", "invoice one"),
      message("2", "1", "8", "invoice two"),
      message("3", "1", null, "invoice me"),
    ],
    { via: "history" },
  )
  await store.saveMessages(OWNER, "2", [message("4", "2", "8", "invoice four")], { via: "history" })
  return { store, path }
}

const count = async (path: string) => {
  const database = await openCache(path)
  try {
    return Number(database.prepare("SELECT count(*) AS n FROM tags").get()?.n)
  } finally {
    database.close()
  }
}

const found = async (store: MessageStore, text: string) =>
  (await searchStore(store, OWNER, { text, language: "lucene", limit: 100 })).items.map(({ id }) => id).sort()

describe("tags in the store (version 16)", () => {
  it("**adds only what is new and removes only what was there**, answering each", async () => {
    const { store } = await seeded()
    expect(await store.addTags(OWNER, { type: "chat", chatId: "1" }, ["work", "family"])).toEqual(["work", "family"])
    expect(await store.addTags(OWNER, { type: "chat", chatId: "1" }, ["work", "home"])).toEqual(["home"])
    expect(await store.removeTags(OWNER, { type: "chat", chatId: "1" }, ["home", "absent"])).toEqual(["home"])
    expect((await store.tags(OWNER)).map(({ tag }) => tag)).toEqual(["family", "work"])
  })

  it("lists this account's chats and messages and its messenger's people, filtered by tag or type", async () => {
    const { store } = await seeded()
    await store.saveChats(OTHER, [chat("9")])
    await store.addTags(OTHER, { type: "chat", chatId: "9" }, ["work"])
    await store.addTags(OWNER, { type: "chat", chatId: "1" }, ["work"])
    await store.addTags(OWNER, { type: "contact", personId: "7" }, ["work"])
    await store.addTags(OWNER, { type: "message", chatId: "2", messageId: "4" }, ["work", "paid"])

    expect(await store.tags(OWNER, { tag: "work" })).toMatchObject([
      { tag: "work", type: "chat", chatId: "1", chatTitle: "Chat 1" },
      { tag: "work", type: "contact", personId: "7", name: "Person 7" },
      { tag: "work", type: "message", chatId: "2", messageId: "4", locator: "msg:tg/1/2/4" },
    ])
    expect((await store.tags(OWNER, { type: "message" })).map(({ tag }) => tag)).toEqual(["paid", "work"])
    expect((await store.tags(OTHER)).map(({ type, tag }) => `${type}:${tag}`)).toEqual(["chat:work", "contact:work"])
  })

  it("refuses a chat, person or message the store does not hold", async () => {
    const { store } = await seeded()
    for (const target of [
      { type: "chat", chatId: "404" },
      { type: "contact", personId: "404" },
      { type: "message", chatId: "1", messageId: "404" },
    ] as const)
      await expect(store.addTags(OWNER, target, ["work"])).rejects.toMatchObject({ code: "not_found" })
  })

  it("**a deleted message loses its tags**, whether marked deleted or purged with its chat", async () => {
    const { store, path } = await seeded()
    await store.addTags(OWNER, { type: "message", chatId: "1", messageId: "1" }, ["work"])
    await store.addTags(OWNER, { type: "message", chatId: "1", messageId: "2" }, ["work"])
    await store.addTags(OWNER, { type: "chat", chatId: "1" }, ["work"])
    await store.addTags(OWNER, { type: "contact", personId: "8" }, ["work"])

    await store.markDeleted(OWNER, ["1"], { chatId: "1" })
    expect((await store.tags(OWNER, { type: "message" })).map(({ messageId }) => messageId)).toEqual(["2"])

    await store.purge(OWNER)
    expect(await count(path)).toBe(1)
    expect((await store.tags(OWNER)).map(({ type }) => type)).toEqual(["contact"])
  })
})

describe("tag: in a strict search", () => {
  it("**matches a message tagged, in a tagged chat, or from a tagged person**; NOT is exact", async () => {
    const { store } = await seeded()
    await store.addTags(OWNER, { type: "message", chatId: "1", messageId: "1" }, ["work"])
    await store.addTags(OWNER, { type: "contact", personId: "8" }, ["work"])
    await store.addTags(OWNER, { type: "chat", chatId: "2" }, ["home", "work"])

    expect(await found(store, "tag:work")).toEqual(["1", "2", "4"])
    expect(await found(store, "tag:WORK invoice")).toEqual(["1", "2", "4"])
    expect(await found(store, "invoice NOT tag:work")).toEqual(["3"])
    expect(await found(store, "tag:home")).toEqual(["4"])
    expect(await found(store, "tag:home OR tag:nothing")).toEqual(["4"])
    expect(await found(store, "tag:nothing")).toEqual([])
  })

  it("counts by tag the same messages it finds", async () => {
    const { store } = await seeded()
    await store.addTags(OWNER, { type: "contact", personId: "8" }, ["work"])
    const stats = await statsStore(store, OWNER, { text: "tag:work", language: "lucene", limit: 10, by: "chat" })
    expect(stats.items.map(({ key, count }) => [key, count])).toEqual([
      ["1", 1],
      ["2", 1],
    ])
  })

  it("refuses a tag that is not one", async () => {
    const { store } = await seeded()
    await expect(found(store, 'tag:"two words"')).rejects.toMatchObject({
      code: "validation_error",
      details: { reason: "invalid_tag" },
    })
  })
})

describe("a build on version 6, on a version 16 file", () => {
  it("**keeps reading and writing, and its deletions drop tags too**: the triggers live in the file", async () => {
    const { store, path } = await seeded()
    await store.addTags(OWNER, { type: "message", chatId: "1", messageId: "2" }, ["work"])
    await store.close()
    live.splice(0)

    const { openStore: openOlder } = await import("cli-messaging-0.49/store")
    const older = await openOlder({ path })
    await older.saveMessages(OWNER, "1", [message("5", "1", "7", "later")], { via: "history" })
    await older.markDeleted(OWNER, ["2"], { chatId: "1" })
    expect((await older.messages(OWNER, "1", { limit: 10 })).items.map(({ id }) => id)).toContain("5")
    await older.close()
    expect(await count(path)).toBe(0)
  })
})
