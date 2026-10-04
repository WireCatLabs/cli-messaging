import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import { chunkHash } from "../conversations/chunks.js"
import type { Message } from "../domain/models.js"
import type { TextModel } from "../embeddings/models.js"
import type { SendGuard } from "../sends/guard.js"
import { openCache } from "../store/open.js"
import { openStore } from "../store/store.js"
import { conversationsService } from "./conversations.js"
import { storedDeps } from "./deps.js"
import { embeddingsService } from "./embeddings.js"

const tiny: TextModel = {
  id: "tiny",
  title: "a five-word model",
  languages: "test",
  licence: "none",
  dims: 4,
  maxTokens: 64,
  chunksPerSecond: 1,
  pooling: "mean",
  prefix: { query: "", passage: "" },
  onnx: "onnx/model.onnx",
  files: [{ name: "onnx/model.onnx", url: "", sha256: "", bytes: 318 }],
}

vi.mock("../embeddings/models.js", async (original) => {
  const real = await original<typeof import("../embeddings/models.js")>()
  return {
    ...real,
    textModel: (id: string) => (id === "tiny" ? tiny : id === "tiny-2" ? { ...tiny, id } : real.textModel(id)),
  }
})

const account = { provider: "test", account: "1" }

const message = (id: string, text: string, replyToId?: string): Message => ({
  id,
  chatId: "9",
  senderId: "100",
  senderName: null,
  timestamp: new Date(Date.parse("2026-10-01T00:00:00Z") + Number(id) * 3_600_000).toISOString(),
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  ...(replyToId ? { replyToId } : {}),
  forwardedFrom: null,
  reactions: null,
})

const setUp = async ({
  build = true,
  messages = [message("1", "cat dog"), message("2", "dog", "1"), message("40", "fish"), message("80", "cat")],
} = {}) => {
  const path = join(mkdtempSync(join(tmpdir(), "embed-")), "m.db")
  const store = await openStore({ path })
  await store.saveChats(account, [
    { id: "9", title: "Group", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
  ])
  await store.saveMessages(account, "9", messages, { via: "history" })
  const deps = storedDeps({ provider: "test", app: { command: "chat" } } as Messenger, store, account, {} as SendGuard)
  const conversations = conversationsService(deps)
  if (build) await conversations.build("9")
  return { store, embeddings: embeddingsService(deps), conversations, path }
}

beforeEach(() => {
  const cache = mkdtempSync(join(tmpdir(), "models-"))
  mkdirSync(join(cache, "models", "text"), { recursive: true })
  for (const id of ["tiny", "tiny-2"]) {
    symlinkSync(
      fileURLToPath(new URL("../embeddings/fixtures/tiny", import.meta.url)),
      join(cache, "models", "text", id),
    )
  }
  vi.stubEnv("CLI_COMMON_CACHE_DIR", cache)
})
afterEach(() => vi.unstubAllEnvs())

describe("embeddings", () => {
  it("**embeds every chunk of the current build once**, and a second run embeds nothing", async () => {
    const { store, embeddings } = await setUp()
    expect(await embeddings.status("9", "tiny")).toMatchObject({ chunks: 3, embedded: 0, left: 3 })

    const seen: number[] = []
    const done = await embeddings.embed("9", { model: "tiny", threads: 1, progress: (embedded) => seen.push(embedded) })

    expect(done).toEqual({ chat: "9", model: "tiny", embedded: 3, skipped: 0 })
    expect(seen.at(-1)).toBe(3)
    expect(await embeddings.status("9", "tiny")).toMatchObject({ chunks: 3, embedded: 3, left: 0 })
    expect((await embeddings.embed("9", { model: "tiny", threads: 1 })).embedded).toBe(0)

    expect(await embeddings.clear("9", "tiny")).toEqual({ chat: "9", cleared: 3 })
    expect(await embeddings.status("9", "tiny")).toMatchObject({ embedded: 0, left: 3 })
    await store.close()
  })

  it("**finds the conversation nearest in meaning**, best first, with the chunk that matched", async () => {
    const { store, embeddings } = await setUp()
    await embeddings.embed("9", { model: "tiny", threads: 1 })

    const { hits } = await embeddings.search("fish", { model: "tiny", limit: 3 })

    expect(hits).toHaveLength(3)
    expect([hits[0]?.summary.firstMessageId, hits[0]?.chunk]).toEqual([
      "40",
      { firstMessageId: "40", lastMessageId: "40" },
    ])
    expect(hits[0]?.score).toBeCloseTo(1)
    expect(
      (await embeddings.search("fish", { model: "tiny", chat: "9", limit: 5, since: "2026-10-03T00:00:00Z" })).hits.map(
        ({ summary }) => summary.firstMessageId,
      ),
    ).toEqual(["80"])
    await store.close()
  })

  it("names a chat embedded only with another model, which the search finds by words alone", async () => {
    const { store, embeddings } = await setUp()
    await embeddings.embed("9", { model: "tiny", threads: 1 })

    expect(await embeddings.search("fish", { model: "tiny-2", limit: 3 })).toMatchObject({
      hits: [{ summary: { firstMessageId: "40" }, score: null, by: ["words"] }],
      embeddedOnlyElsewhere: ["9"],
    })
    expect((await embeddings.search("fish", { model: "tiny", limit: 3 })).embeddedOnlyElsewhere).toEqual([])
    await store.close()
  })

  it("**merges meaning and words**: a word only one message holds, and a meaning no message spells, each land first", async () => {
    const { store, embeddings } = await setUp({
      messages: [message("1", "cat cat"), message("40", "dog zebra"), message("80", "dog"), message("120", "fish")],
    })
    await embeddings.embed("9", { model: "tiny", threads: 1 })

    const [byMeaning] = (await embeddings.search("kitten", { model: "tiny", limit: 4 })).hits
    expect(byMeaning).toMatchObject({ summary: { firstMessageId: "1" }, by: ["meaning"] })
    expect(byMeaning?.score).toBeCloseTo(1)

    const [byWords] = (await embeddings.search("zebra", { model: "tiny", limit: 4 })).hits
    expect(byWords).toMatchObject({
      summary: { firstMessageId: "40" },
      chunk: { firstMessageId: "40", lastMessageId: "40" },
      by: ["meaning", "words"],
    })
    await store.close()
  })

  it("leaves out what the word search finds only by correcting the query, keeps a word's longer forms", async () => {
    const { store, embeddings } = await setUp({ messages: [message("1", "kitchen")] })
    expect((await embeddings.search("kitten", { model: "tiny", limit: 4 })).hits).toEqual([])

    await store.saveMessages(account, "9", [message("40", "kittens")], { via: "history" })
    await conversationsService(
      storedDeps({ provider: "test", app: { command: "chat" } } as Messenger, store, account, {} as SendGuard),
    ).build("9")
    expect((await embeddings.search("kitten", { model: "tiny", limit: 4 })).hits).toMatchObject([
      { summary: { firstMessageId: "40" }, by: ["words"] },
    ])
    await store.close()
  })

  it("refuses a chat with no conversations, and a model that is not downloaded, naming what to run", async () => {
    const { store, embeddings } = await setUp({ build: false })
    await expect(embeddings.embed("9", { model: "tiny" })).rejects.toThrow("chat conversations build --chat 9")
    await conversationsService(
      storedDeps({ provider: "test", app: { command: "chat" } } as Messenger, store, account, {} as SendGuard),
    ).build("9")
    await expect(embeddings.embed("9", { model: "e5-small" })).rejects.toThrow("chat models text download e5-small")
    await store.close()
  })
})

describe("derived index freshness", () => {
  const edited = (id: string, text: string): Message => ({
    ...message(id, text),
    editedAt: "2026-10-05T00:00:00.000Z",
  })

  it("returns a hit whose text was edited away as stale, and counts the edit as pending", async () => {
    const { store, embeddings, conversations } = await setUp()
    await embeddings.embed("9", { model: "tiny", threads: 1 })
    await store.saveMessages(account, "9", [edited("40", "zebra")], { via: "live" })

    const found = await embeddings.search("fish", { model: "tiny", limit: 3 })
    expect(found.hits[0]).toMatchObject({ summary: { firstMessageId: "40" }, by: ["meaning"], stale: true })
    expect(found.hits[0]?.score).toBeCloseTo(1)
    expect(found.hits.slice(1).map(({ stale }) => stale)).toEqual([false, false])
    expect(found.readiness).toMatchObject({ searchedByMeaning: ["9"], stale: ["9"], partial: [] })
    expect((await embeddings.readiness({ chat: "9", model: "tiny" })).chats).toMatchObject([
      {
        state: "stale",
        pending: { new: 0, edited: 1, deleted: 0 },
        vectors: { chunks: 3, current: 2, stale: 1, missing: 0 },
      },
    ])

    await conversations.build("9")
    expect((await embeddings.readiness({ chat: "9", model: "tiny" })).chats).toMatchObject([
      { state: "partial", pending: { edited: 0 }, vectors: { chunks: 3, current: 2, stale: 0, missing: 1 } },
    ])
    await store.close()
  })

  it("purges the vector of a deleted message's text and never returns the hit", async () => {
    const { store, embeddings, path } = await setUp()
    await embeddings.embed("9", { model: "tiny", threads: 1 })
    await store.markDeleted(account, ["40"], { chatId: "9" })

    expect(await vectorRows(path, chunkHash("fish"))).toBe(0)
    const found = await embeddings.search("fish", { model: "tiny", limit: 3 })
    expect(found.hits.map(({ summary }) => summary.firstMessageId)).not.toContain("40")
    expect((await embeddings.readiness({ chat: "9", model: "tiny" })).chats).toMatchObject([
      { state: "stale", pending: { deleted: 1 }, vectors: { chunks: 3, current: 2, stale: 1, missing: 0 } },
    ])
    await store.close()
  })

  it("drops a hit on a deleted message even when its vector is still there", async () => {
    const { store, embeddings, path } = await setUp()
    await embeddings.embed("9", { model: "tiny", threads: 1 })
    const kept = await vectorOf(path, chunkHash("fish"))
    await store.markDeleted(account, ["40"], { chatId: "9" })
    await store.saveVectors("local:tiny:4", 4, [{ hash: chunkHash("fish"), vector: kept }])

    const found = await embeddings.search("fish", { model: "tiny", limit: 3 })
    expect(found.hits.map(({ summary }) => summary.firstMessageId)).not.toContain("40")
    await store.close()
  })

  it("keeps the vector another chat's current chunk shares when a message is deleted", async () => {
    const { store, embeddings, conversations, path } = await setUp()
    await store.saveChats(account, [
      { id: "10", title: "Other", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
    ])
    await store.saveMessages(account, "10", [{ ...message("500", "fish"), chatId: "10" }], { via: "history" })
    await conversations.build("10")
    await embeddings.embed("9", { model: "tiny", threads: 1 })
    await embeddings.embed("10", { model: "tiny", threads: 1 })
    await store.markDeleted(account, ["40"], { chatId: "9" })

    expect(await vectorRows(path, chunkHash("fish"))).toBe(1)
    const [top] = (await embeddings.search("fish", { model: "tiny", limit: 5 })).hits
    expect(top).toMatchObject({ summary: { chatId: "10", firstMessageId: "500" }, stale: false })
    const inNine = (await embeddings.search("fish", { model: "tiny", chat: "9", limit: 5 })).hits
    expect(inNine.map(({ summary }) => summary.firstMessageId)).not.toContain("40")
    await store.close()
  })

  it("counts a message saved after the build as pending, though its word match stays hidden until a rebuild", async () => {
    const { store, embeddings } = await setUp()
    await embeddings.embed("9", { model: "tiny", threads: 1 })
    await store.saveMessages(account, "9", [message("120", "zebra")], { via: "live" })

    const found = await embeddings.search("zebra", { model: "tiny", limit: 5 })
    expect(found.hits.filter(({ by }) => by.includes("words"))).toEqual([])
    expect(found.readiness).toMatchObject({ stale: ["9"], notBuilt: [] })
    expect((await embeddings.readiness({ model: "tiny" })).chats).toMatchObject([
      { chat: "9", state: "stale", pending: { new: 1, edited: 0, deleted: 0 }, vectors: { current: 3, missing: 0 } },
    ])
    await store.close()
  })

  it("names a chat missing some vectors of the model as partial, and keeps embeddedOnlyElsewhere", async () => {
    const { store, embeddings, conversations } = await setUp()
    await embeddings.embed("9", { model: "tiny", threads: 1 })
    await embeddings.embed("9", { model: "tiny-2", threads: 1 })
    await store.saveMessages(account, "9", [message("120", "zebra")], { via: "live" })
    await conversations.build("9")
    await embeddings.embed("9", { model: "tiny", threads: 1 })

    const found = await embeddings.search("zebra", { model: "tiny-2", limit: 5 })
    expect(found.embeddedOnlyElsewhere).toEqual([])
    expect(found.readiness).toEqual({
      searchedByMeaning: ["9"],
      wordsOnly: [],
      partial: ["9"],
      stale: [],
      notBuilt: [],
    })
    expect((await embeddings.readiness({ model: "tiny-2" })).chats).toMatchObject([
      { state: "partial", vectors: { chunks: 4, current: 3, stale: 0, missing: 1 } },
    ])
    await store.close()
  })

  it("returns every conversation by meaning, even at score 0, and ranks the only word match below one (no floor, known gap)", async () => {
    const { store, embeddings, conversations } = await setUp({
      messages: [message("1", "cat dog"), message("40", "fish")],
    })
    await embeddings.embed("9", { model: "tiny", threads: 1 })
    await store.saveMessages(account, "9", [message("80", "zebra")], { via: "live" })
    await conversations.build("9")

    const { hits } = await embeddings.search("zebra", { model: "tiny", limit: 5 })
    expect(hits.map(({ summary, score, by }) => [summary.firstMessageId, score, by])).toEqual([
      ["1", 0, ["meaning"]],
      ["80", null, ["words"]],
      ["40", 0, ["meaning"]],
    ])
    await store.close()
  })

  it("searches by words alone when the model is not downloaded, and says so", async () => {
    const { store, embeddings } = await setUp()
    const found = await embeddings.search("fish", { model: "e5-small", limit: 5 })
    expect(found).toMatchObject({
      model: "e5-small",
      meaning: "unavailable",
      hits: [{ summary: { firstMessageId: "40" }, score: null, by: ["words"], stale: false }],
      readiness: { searchedByMeaning: [], wordsOnly: ["9"], partial: [] },
    })
    await store.close()
  })

  it("reports a chat never built, one built under older rules, and readiness with no hits", async () => {
    const { store, embeddings, conversations, path } = await setUp({ build: false })
    expect((await embeddings.readiness({ model: "tiny" })).chats).toEqual([])
    expect((await embeddings.readiness({ chat: "9", model: "tiny" })).chats).toEqual([
      {
        chat: "9",
        state: "not-built",
        graph: null,
        pending: { new: 0, edited: 0, deleted: 0 },
        vectors: { chunks: 0, current: 0, stale: 0, missing: 0 },
      },
    ])
    const unbuilt = await embeddings.search("fish", { model: "tiny", limit: 5 })
    expect([unbuilt.hits, unbuilt.readiness.notBuilt]).toEqual([[], ["9"]])

    await conversations.build("9")
    const nothing = await embeddings.search("kitten", { model: "tiny", chat: "9", limit: 5 })
    expect([nothing.hits, nothing.readiness]).toMatchObject([[], { wordsOnly: ["9"], notBuilt: [], stale: [] }])
    expect((await embeddings.readiness({ model: "tiny" })).chats).toMatchObject([
      { state: "words-only", graph: { outdatedRules: false }, vectors: { chunks: 3, missing: 3 } },
    ])

    await store.saveMessages(account, "9", [{ ...message("40", "zebra"), editedAt: "2026-10-05T00:00:00.000Z" }], {
      via: "live",
    })
    const edited = await embeddings.search("kitten", { model: "tiny", chat: "9", limit: 5 })
    expect(edited.readiness).toMatchObject({ searchedByMeaning: [], wordsOnly: ["9"], stale: ["9"] })
    await conversations.build("9")

    await withDatabase(path, (run) => run("UPDATE conversation_state SET algorithm_version = 1"))
    await embeddings.embed("9", { model: "tiny", threads: 1 })
    expect((await embeddings.readiness({ model: "tiny" })).chats).toMatchObject([
      { state: "stale", graph: { rulesVersion: 1, outdatedRules: true } },
    ])
    await store.close()
  })
})

const withDatabase = async <T>(path: string, body: (run: (sql: string) => Record<string, unknown>[]) => T) => {
  const database = await openCache(path)
  try {
    return body((sql) =>
      database
        .prepare(sql)
        .all()
        .map((row) => ({ ...row })),
    )
  } finally {
    database.close()
  }
}

const vectorRows = (path: string, hash: string) =>
  withDatabase(path, (run) =>
    Number(run(`SELECT count(*) AS n FROM chunk_vectors WHERE content_hash = '${hash}'`)[0]?.n),
  )

const vectorOf = (path: string, hash: string) =>
  withDatabase(path, (run) => {
    const blob = run(`SELECT vector FROM chunk_vectors WHERE content_hash = '${hash}'`)[0]?.vector as Uint8Array
    return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength))
  })
