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

  it("finds one message by its id, and asks for the chat when two chats share the id", async () => {
    const store = await openStore({ path: fresh() })
    store.saveMessages(ME, chat.id, [message()], { via: "history" })
    expect(store.message(ME, "42")?.text).toBe("empadronamiento renewal")
    expect(store.message(ME, "43")).toBeUndefined()

    store.saveMessages(ME, "555", [message({ chatId: "555" })], { via: "history" })
    expect(() => store.message(ME, "42")).toThrow(expect.objectContaining({ code: "validation_error" }))
    expect(store.message(ME, "42", { chatId: "555" })?.chatId).toBe("555")
    store.close()
  })

  it("keeps a deleted message out of reads and search, in its own chat only", async () => {
    const store = await openStore({ path: fresh() })
    store.saveMessages(ME, chat.id, [message(), message({ id: "43" })], { via: "history" })
    store.saveMessages(ME, "555", [message({ chatId: "555" })], { via: "history" })

    expect(store.markDeleted(ME, ["42"], { chatId: chat.id })).toBe(1)
    expect(store.markDeleted(ME, ["42"], { chatId: chat.id })).toBe(0)
    expect(store.messages(ME, chat.id, { limit: 10 }).items.map((one) => one.id)).toEqual(["43"])
    expect(store.message(ME, "42", { chatId: chat.id })).toBeUndefined()
    expect(store.message(ME, "42", { chatId: "555" })).toBeDefined()
    expect(
      store
        .search("empadronamiento", { limit: 10 })
        .items.map((hit) => hit.chatId)
        .sort(),
    ).toEqual(["-1001234567890", "555"])
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

describe("finding people and what they wrote", () => {
  const BOT: AccountKey = { provider: "max-bot", account: "1" }
  const OTHER_BOT: AccountKey = { provider: "max-bot", account: "2" }
  const said = (id: string, chatId: string, senderId: string, text: string, minute: number): Message =>
    message({
      id,
      chatId,
      senderId,
      senderName: `person ${senderId}`,
      text,
      timestamp: `2026-09-27T10:${String(minute).padStart(2, "0")}:00.000Z`,
      attachments: [],
      replyTo: null,
      replyToId: undefined,
    })

  const seeded = async () => {
    const store = await openStore({ path: fresh() })
    store.saveMessages(
      BOT,
      "10",
      [said("a", "10", "7", "hello from seven", 1), said("b", "10", "8", "eight here", 2)],
      {
        via: "history",
      },
    )
    store.saveMessages(BOT, "20", [said("c", "20", "7", "seven alone", 3)], { via: "history" })
    store.saveMessages(
      OTHER_BOT,
      "30",
      [said("d", "30", "7", "seven again", 4), said("e", "30", "8", "eight again", 5), said("f", "30", "9", "nine", 6)],
      { via: "history" },
    )
    return store
  }

  it("keeps the messages of any sender, newest first, in one account or across a provider", async () => {
    const store = await seeded()
    expect(store.find({ account: BOT, senders: ["7"], limit: 10 }).items.map(({ id }) => id)).toEqual(["c", "a"])
    expect(store.find({ provider: "max-bot", senders: ["7", "9"], limit: 10 }).items.map(({ id }) => id)).toEqual([
      "f",
      "d",
      "c",
      "a",
    ])
    store.close()
  })

  it("keeps only the chats where every sender wrote, with `together`", async () => {
    const store = await seeded()
    const page = store.find({ provider: "max-bot", senders: ["7", "8"], together: true, limit: 10 })
    expect(page.items.map(({ id }) => id)).toEqual(["e", "d", "b", "a"])
    store.close()
  })

  it("caps each chat rather than all of them, with `perChat`", async () => {
    const store = await seeded()
    const page = store.find({ provider: "max-bot", senders: ["7", "8"], together: true, perChat: true, limit: 1 })
    expect(page).toMatchObject({ items: [{ id: "e" }, { id: "b" }], hasMore: true })
    store.close()
  })

  it("combines text with a sender and leaves a deleted message out", async () => {
    const store = await seeded()
    const page = store.find({ provider: "max-bot", senders: ["7"], text: "again", limit: 10 })
    expect(page.items.map(({ id }) => id)).toEqual(["d"])
    store.markDeleted(OTHER_BOT, ["d"])
    expect(store.find({ provider: "max-bot", senders: ["7"], text: "again", limit: 10 }).items).toEqual([])
    store.close()
  })

  it("finds nothing for a sender it has never seen, and refuses a filter with neither text nor sender", async () => {
    const store = await seeded()
    expect(store.find({ provider: "max-bot", senders: ["404"], limit: 10 }).items).toEqual([])
    expect(() => store.find({ provider: "max-bot", limit: 10 })).toThrow("say what to find")
    store.close()
  })

  it("remembers a username and a bot flag, and a later name alone does not erase them", async () => {
    const store = await seeded()
    store.savePeople("max-bot", [{ id: "7", name: "Seven", username: "seven", isBot: false }])
    store.saveMessages(BOT, "10", [said("g", "10", "7", "renamed", 7)], { via: "update" })
    expect(store.people("max-bot").get("7")).toMatchObject({ name: "person 7", username: "seven" })
    expect(
      store
        .people("max-bot", { account: "1" })
        .all()
        .map(({ id }) => id)
        .toSorted(),
    ).toEqual(["7", "8"])
    store.close()
  })
})

describe("searching message text", () => {
  it("**finds a Russian word by its stem, whatever its ending**, and every word asked for", async () => {
    const store = await openStore({ path: fresh() })
    store.saveMessages(
      ME,
      chat.id,
      [
        message({ id: "1", text: "Сдаю квартиру в центре" }),
        message({ id: "2", text: "Ищу квартира рядом с морем" }),
        message({ id: "3", text: "Продаю машину в центре" }),
      ],
      { via: "history" },
    )
    const ids = (query: string) =>
      store
        .search(query, { limit: 10 })
        .items.map((hit) => hit.id)
        .sort()

    expect(ids("квартир")).toEqual(["1", "2"])
    expect(ids("квартир центр")).toEqual(["1"])
    expect(ids("вартир")).toEqual([])
    store.close()
  })
})

describe("the stretches held completely", () => {
  it("**merge when they overlap or touch**, and stay apart across a gap", async () => {
    const store = await openStore({ path: fresh() })
    store.markRange(ME, chat.id, 100, 200)
    store.markRange(ME, chat.id, 300, 400)
    expect(store.markRange(ME, chat.id, 201, 250)).toEqual({ from: 100, to: 250 })
    expect(store.ranges(ME, chat.id)).toEqual([
      { from: 100, to: 250 },
      { from: 300, to: 400 },
    ])
    expect(store.markRange(ME, chat.id, 240, 310)).toEqual({ from: 100, to: 400 })
    expect(store.ranges(ME, chat.id)).toEqual([{ from: 100, to: 400 }])
    store.close()
  })
})

describe("migrating the store", () => {
  const latest = MIGRATIONS.at(-1)?.version ?? 0
  const next = { version: latest + 1, minCompatible: 1, statements: ["ALTER TABLE chats ADD COLUMN folder TEXT"] }

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
    migrate(newer, { migrations: [...MIGRATIONS, { ...next, minCompatible: next.version }] })
    newer.close()

    await expect(openStore({ path })).rejects.toMatchObject({ code: "configuration_error" })
    const database = await openCache(path)
    expect(database.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual(
      [...MIGRATIONS, next].map(({ version }) => ({ version })),
    )
    database.close()
  })

  it("**brings a file from every shipped version forward** without losing a message", async () => {
    for (const shipped of MIGRATIONS.slice(0, -1)) {
      const path = fresh()
      const older = await openCache(path)
      migrate(older, { migrations: MIGRATIONS.filter(({ version }) => version <= shipped.version) })
      // Written the way that version wrote it — named columns, the ones version 1 has.
      older.exec(`INSERT INTO accounts (pk, provider, native_id, created_at) VALUES (1, 'telegram', '100', 0)`)
      older.exec(
        `INSERT INTO chats (pk, account_pk, native_id, kind, updated_at) VALUES (1, 1, '${chat.id}', 'group', 0)`,
      )
      older.exec(`INSERT INTO messages (chat_pk, account_pk, native_id, sent_at, text, ingested_at, ingested_via)
                  VALUES (1, 1, '42', 1, 'kept across the upgrade', 0, 'history')`)
      older.close()

      const store = await openStore({ path })
      expect(store.messages(ME, chat.id, { limit: 5 }).items.map((one) => one.text)).toEqual([
        "kept across the upgrade",
      ])
      expect(store.search("across", { limit: 5 }).items.map((hit) => hit.id)).toEqual(["42"])
      store.close()
    }
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
