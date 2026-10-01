import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Chat, Message } from "../domain/models.js"
import type { Term } from "../search/query.js"
import { openCache } from "./open.js"
import { type AccountKey, type MessageStore, openStore } from "./store.js"

const ME: AccountKey = { provider: "telegram", account: "100" }
const OTHER: AccountKey = { provider: "telegram", account: "200" }
const word = (text: string): Term => ({ kind: "word", text })
const every = (...words: string[]) => ({ required: words.map((text) => [word(text)]), excluded: [] })
const ids = (page: { items: { id: string }[] }) => page.items.map((hit) => hit.id)

const chat = (id: string, title = `Chat ${id}`): Chat => ({
  id,
  title,
  kind: "group",
  unreadCount: 0,
  lastMessageAt: null,
  participantsCount: null,
})

let minute = 0
const message = (chatId: string, id: string, text: string, extra: Partial<Message> = {}): Message => ({
  id,
  chatId,
  senderId: "7",
  senderName: "Ana",
  timestamp: new Date(Date.UTC(2026, 8, 1, 10, minute++)).toISOString(),
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
  ...extra,
})

const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

const opened = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "words-")), "messages.db")
  const store = await openStore({ path })
  stores.push(store)
  await store.saveChats(ME, [chat("1"), chat("2", "Hidden")])
  return { store, path }
}

const options = { mode: "every" as const, beginnings: false, limit: 10 }

describe("matchWords", () => {
  it("**finds every word**, and **the word TIE before tiempo** — whole words first, beginnings after", async () => {
    const { store } = await opened()
    await store.saveMessages(
      ME,
      "1",
      [message("1", "1", "Lunch tomorrow, wear a tie"), message("1", "2", "No tengo tiempo"), message("1", "3", "tie")],
      { via: "history" },
    )

    expect(ids(await store.matchWords(every("tie"), { accounts: [ME] }, options)).sort()).toEqual(["1", "3"])
    expect(
      ids(await store.matchWords(every("tie"), { accounts: [ME] }, { ...options, beginnings: true })).sort(),
    ).toEqual(["1", "2", "3"])
    expect(ids(await store.matchWords(every("wear", "tie"), { accounts: [ME] }, options))).toEqual(["1"])
  })

  it("**ranks by bm25**, and equal scores newest first", async () => {
    const { store } = await opened()
    await store.saveMessages(
      ME,
      "1",
      [
        message("1", "1", "valencia"),
        message("1", "2", "a long message that mentions valencia once among many other words here"),
        message("1", "3", "valencia"),
      ],
      { via: "history" },
    )
    const found = await store.matchWords(every("valencia"), { accounts: [ME] }, options)

    expect(ids(found)).toEqual(["3", "1", "2"])
    expect(found.items[0]?.score).toEqual(expect.any(Number))
    expect(ids(await store.matchWords(every("valencia"), { accounts: [ME] }, { ...options, newest: true }))).toEqual([
      "3",
      "2",
      "1",
    ])
  })

  it('takes any word, "a phrase", and leaves a word out', async () => {
    const { store } = await opened()
    await store.saveMessages(
      ME,
      "1",
      [
        message("1", "1", "piso compartido en Ruzafa"),
        message("1", "2", "compartido el piso"),
        message("1", "3", "alquiler de piso"),
      ],
      { via: "history" },
    )
    const phrase = { required: [[{ kind: "phrase", words: ["piso", "compartido"] } as Term]], excluded: [] }

    expect(ids(await store.matchWords(phrase, { accounts: [ME] }, options))).toEqual(["1"])
    expect(
      ids(
        await store.matchWords({ ...every("piso"), excluded: [word("alquiler")] }, { accounts: [ME] }, options),
      ).sort(),
    ).toEqual(["1", "2"])
    expect(
      ids(await store.matchWords(every("ruzafa", "alquiler"), { accounts: [ME] }, { ...options, mode: "any" })).sort(),
    ).toEqual(["1", "3"])
  })

  it("**keeps to the accounts given**, even when the best-ranked rows are another account's", async () => {
    const { store } = await opened()
    await store.saveChats(OTHER, [chat("9")])
    await store.saveMessages(
      OTHER,
      "9",
      Array.from({ length: 30 }, (_, index) => message("9", String(index), "valencia")),
      { via: "history" },
    )
    await store.saveMessages(ME, "1", [message("1", "1", "valencia is far from here, they say")], { via: "history" })

    expect(ids(await store.matchWords(every("valencia"), { accounts: [ME] }, { ...options, limit: 2 }))).toEqual(["1"])
    expect((await store.matchWords(every("valencia"), { accounts: [ME, OTHER] }, options)).hasMore).toBe(true)
  })

  it("**gives the same rows, in the same order and score, for a chat as a token and as a join**", async () => {
    const { store, path } = await opened()
    await store.saveMessages(
      ME,
      "1",
      [
        message("1", "1", "valencia"),
        message("1", "2", "valencia madrid sevilla bilbao", { senderId: "8" }),
        message("1", "3", "valencia valencia madrid"),
      ],
      { via: "history" },
    )
    await store.saveMessages(ME, "2", [message("2", "4", "valencia")], { via: "history" })
    const inChat = { accounts: [ME], chat: { account: ME, chatId: "1" } }
    const ranked = async () =>
      (await store.matchWords(every("valencia"), inChat, options)).items.map(({ id, score }) => [id, score])
    const asToken = await ranked()

    const database = await openCache(path)
    database.exec("UPDATE chats SET message_count = 1000000 WHERE native_id = '1'")
    database.close()

    expect(asToken.map(([id]) => id).sort()).toEqual(["1", "2", "3"])
    expect(await ranked()).toEqual(asToken)
  })

  it("filters by sender — **one learned on a later save too** — by time, by what was sent and what is attached", async () => {
    const { store } = await opened()
    const at = (minutes: number) => ({ timestamp: new Date(Date.UTC(2026, 0, 1, 10, minutes)).toISOString() })
    await store.saveMessages(
      ME,
      "1",
      [
        message("1", "1", "valencia", { ...at(1), senderId: null, senderName: null }),
        message("1", "2", "valencia", { ...at(2), senderId: "8", senderName: "Bea" }),
        message("1", "3", "valencia https://example.com", { ...at(3), outgoing: true }),
        message("1", "4", "valencia", { ...at(4), attachments: [{ kind: "photo" }] }),
      ],
      { via: "history" },
    )
    await store.saveMessages(ME, "1", [message("1", "1", "valencia", at(1))], { via: "history" })
    const scoped = (scope: object) => store.matchWords(every("valencia"), { accounts: [ME], ...scope }, options)

    expect(ids(await scoped({ sender: { provider: "telegram", id: "8" } }))).toEqual(["2"])
    expect(ids(await scoped({ sender: { provider: "telegram", id: "7" } })).sort()).toEqual(["1", "3", "4"])
    expect(ids(await scoped({ outgoing: true }))).toEqual(["3"])
    expect(ids(await scoped({ has: ["photo"] }))).toEqual(["4"])
    expect(ids(await scoped({ has: ["link"] }))).toEqual(["3"])
    expect(ids(await scoped({ has: ["attachment"] }))).toEqual(["4"])
    const third = Date.UTC(2026, 0, 1, 10, 3)
    expect(ids(await scoped({ after: third })).sort()).toEqual(["3", "4"])
    expect(ids(await scoped({ before: third })).sort()).toEqual(["1", "2"])
    expect(ids(await scoped({ sender: { provider: "telegram", id: "nobody" } }))).toEqual([])
  })

  it("**leaves out a chat marked not searchable**, unless the search names it, and never a deleted message", async () => {
    const { store, path } = await opened()
    await store.saveMessages(ME, "1", [message("1", "1", "valencia"), message("1", "2", "valencia")], {
      via: "history",
    })
    await store.saveMessages(ME, "2", [message("2", "3", "valencia")], { via: "history" })
    await store.markDeleted(ME, ["2"], { chatId: "1" })
    const database = await openCache(path)
    database.exec("UPDATE chats SET is_searchable = 0 WHERE native_id = '2'")
    database.close()

    expect(ids(await store.matchWords(every("valencia"), { accounts: [ME] }, options))).toEqual(["1"])
    expect(
      ids(await store.matchWords(every("valencia"), { accounts: [ME], chat: { account: ME, chatId: "2" } }, options)),
    ).toEqual(["3"])
  })
})

describe("matchSubstring", () => {
  it("**finds a piece inside a word** that the word index cannot, newest first", async () => {
    const { store } = await opened()
    await store.saveMessages(
      ME,
      "1",
      [message("1", "1", "Valencia"), message("1", "2", "Valence"), message("1", "3", "Madrid")],
      {
        via: "history",
      },
    )

    expect(ids(await store.matchWords(every("len"), { accounts: [ME] }, { ...options, beginnings: true }))).toEqual([])
    expect(ids(await store.matchSubstring(every("len"), { accounts: [ME] }, { limit: 10 }))).toEqual(["2", "1"])
    expect(
      ids(await store.matchSubstring({ ...every("len"), excluded: [word("cia")] }, { accounts: [ME] }, { limit: 10 })),
    ).toEqual(["2"])
    expect(ids(await store.matchSubstring(every("tv"), { accounts: [ME] }, { limit: 10 }))).toEqual([])
  })
})

describe("the typo vocabulary", () => {
  it("**knows a whole word or the beginning of one**", async () => {
    const { store } = await opened()
    await store.saveMessages(ME, "1", [message("1", "1", "квартиру в Валенсии")], { via: "history" })

    expect(await store.knownTerms(["квартир", "квартиру", "Валенсии", "valenca"])).toEqual(
      new Set(["квартир", "квартиру", "Валенсии"]),
    )
  })

  it("**offers words sharing trigrams that the index still has** — not one whose message was deleted", async () => {
    const { store } = await opened()
    await store.saveMessages(ME, "1", [message("1", "1", "valencia"), message("1", "2", "valence")], {
      via: "history",
    })
    await store.fillSearchIndex()
    await store.markDeleted(ME, ["2"], { chatId: "1" })
    const pieces = ["  v", " va", "val", "ale", "len", "enc", "nca", "ca "]

    expect(await store.termCandidates(pieces, { shortest: 5, longest: 9 })).toEqual([{ term: "valencia", docs: 1 }])
  })
})
