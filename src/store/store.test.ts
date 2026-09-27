import { mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Chat, Message } from "../domain/models.js"
import { MIGRATIONS, migrate } from "./migrations.js"
import { openCache } from "./open.js"
import { storePath } from "./path.js"
import { type AccountKey, openStore } from "./store.js"

const fresh = () => join(mkdtempSync(join(tmpdir(), "store-")), "messages.db")
const ME: AccountKey = { provider: "telegram", account: "100" }

const chat: Chat = {
  id: "-1001234567890",
  title: "Valencia expats",
  kind: "group",
  unreadCount: 3,
  lastMessageAt: "2026-09-26T10:00:00.000Z",
  participantsCount: 5000,
  providerMetadata: { chatType: "supergroup" },
}

const message = (overrides: Partial<Message> = {}): Message => ({
  id: "42",
  chatId: chat.id,
  senderId: "777",
  senderName: "Ana",
  timestamp: "2026-09-26T10:00:00.000Z",
  editedAt: null,
  text: "empadronamiento renewal",
  outgoing: false,
  attachments: [{ kind: "photo", width: 800, height: 600, providerRef: { fileId: "abc" } }],
  replyTo: {
    id: "41",
    senderId: "778",
    senderName: "Luis",
    timestamp: null,
    text: "where?",
    attachments: [],
    outgoing: false,
  },
  replyToId: "41",
  forwardedFrom: null,
  threadId: "5",
  reactions: { counts: [{ reaction: "👍", count: 2 }], mine: null, total: 2 },
  providerMetadata: { views: 10 },
  ...overrides,
})

describe("the message store", () => {
  it("**gives back exactly the chat and the message it was given**", async () => {
    const store = await openStore({ path: fresh() })
    store.saveChats(ME, [chat])
    store.saveMessages(ME, chat.id, [message()], { via: "history" })

    expect(store.chats(ME, {}).items).toEqual([chat])
    expect(store.messages(ME, chat.id, { limit: 10 }).items).toEqual([message()])
    store.close()
  })

  it("keeps what an edit replaced, and searches only the new text", async () => {
    const path = fresh()
    const store = await openStore({ path })
    store.saveMessages(ME, chat.id, [message()], { via: "history" })
    store.saveMessages(ME, chat.id, [message()], { via: "history" })
    store.saveMessages(ME, chat.id, [message({ text: "cita previa booked", editedAt: "2026-09-26T11:00:00.000Z" })], {
      via: "update",
    })

    expect(store.search("cita previa", { limit: 5 }).items.map((hit) => hit.locator)).toEqual([
      "msg:telegram/100/-1001234567890/42",
    ])
    expect(store.search("empadronamiento", { limit: 5 }).items).toEqual([])
    const database = await openCache(path)
    expect(database.prepare("SELECT text FROM message_revisions").all()).toEqual([{ text: "empadronamiento renewal" }])
    database.close()
    store.close()
  })

  it("does not let a copy that knows less erase what was stored", async () => {
    const store = await openStore({ path: fresh() })
    store.saveMessages(ME, chat.id, [message()], { via: "history" })
    store.saveMessages(
      ME,
      chat.id,
      [
        message({
          reactions: null,
          replyTo: null,
          senderId: null,
          senderName: null,
          threadId: undefined,
          outgoing: null,
        }),
      ],
      { via: "send" },
    )

    const [kept] = store.messages(ME, chat.id, { limit: 1 }).items
    expect(kept?.reactions?.total).toBe(2)
    expect(kept?.replyTo?.text).toBe("where?")
    expect(kept).toMatchObject({ senderId: "777", senderName: "Ana", threadId: "5", outgoing: false })
    store.close()
  })

  it("gives every new sender an identity and a person of their own, and a channel neither", async () => {
    const path = fresh()
    const store = await openStore({ path })
    store.saveMessages(
      ME,
      chat.id,
      [
        message({ id: "1" }),
        message({ id: "2" }),
        message({ id: "3", senderId: "888", senderName: "Marta" }),
        message({ id: "4", senderId: "-100555", senderName: "News", senderIsChat: true }),
      ],
      { via: "history" },
    )
    store.close()

    const database = await openCache(path)
    const count = (table: string) => database.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n
    expect([count("identities"), count("persons"), count("identity_links"), count("identity_link_events")]).toEqual([
      2, 2, 2, 2,
    ])
    database.close()
  })

  it("pages backwards from a message, oldest to newest within a page", async () => {
    const store = await openStore({ path: fresh() })
    const at = (minute: number) => `2026-09-26T10:0${minute}:00.000Z`
    store.saveMessages(
      ME,
      chat.id,
      [1, 2, 3, 4].map((n) => message({ id: String(n), timestamp: at(n) })),
      { via: "history" },
    )

    const newest = store.messages(ME, chat.id, { limit: 2 })
    expect(newest.items.map((one) => one.id)).toEqual(["3", "4"])
    expect(newest.hasMore).toBe(true)
    expect(store.messages(ME, chat.id, { limit: 2, before: "3" }).items.map((one) => one.id)).toEqual(["1", "2"])
    store.close()
  })

  it("refuses a search too short for its index rather than answering nothing", async () => {
    const store = await openStore({ path: fresh() })
    expect(() => store.search("ab", { limit: 5 })).toThrow(expect.objectContaining({ code: "validation_error" }))
    store.close()
  })

  it.skipIf(process.platform === "win32")("**is readable by nobody else**, its journal files included", async () => {
    const path = fresh()
    const store = await openStore({ path })
    store.saveMessages(ME, chat.id, [message()], { via: "history" })

    for (const file of [path, `${path}-wal`, `${path}-shm`]) expect(statSync(file).mode & 0o777).toBe(0o600)
    store.close()
  })

  it("defaults to the test sandbox, never the owner's file", () => {
    expect(storePath()).toBe(process.env.MESSAGING_STORE)
    expect(storePath({})).toContain("cli-messaging")
  })
})

describe("migrating the store", () => {
  const next = { version: 2, minCompatible: 1, statements: ["ALTER TABLE chats ADD COLUMN folder TEXT"] }

  it("opens a newer file this version can still write to, and changes nothing in it", async () => {
    const path = fresh()
    const newer = await openCache(path)
    migrate(newer, { migrations: [...MIGRATIONS, next] })
    newer.close()

    const store = await openStore({ path })
    store.saveChats(ME, [chat])
    expect(store.chats(ME, {}).items).toEqual([chat])
    store.close()
  })

  it("**refuses a newer file it cannot write to**, and leaves it as it was", async () => {
    const path = fresh()
    const newer = await openCache(path)
    migrate(newer, { migrations: [...MIGRATIONS, { ...next, minCompatible: 2 }] })
    newer.close()

    await expect(openStore({ path })).rejects.toMatchObject({ code: "configuration_error" })
    const database = await openCache(path)
    expect(database.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: 1 },
      { version: 2 },
    ])
    database.close()
  })

  it("brings an older file forward without losing a message", async () => {
    const path = fresh()
    const store = await openStore({ path })
    store.saveMessages(ME, chat.id, [message()], { via: "history" })
    store.close()

    const database = await openCache(path)
    migrate(database, { migrations: [...MIGRATIONS, next] })
    expect(database.prepare("SELECT count(*) AS n FROM messages").get()?.n).toBe(1)
    database.close()
  })
})
