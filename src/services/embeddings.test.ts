import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { Message } from "../domain/models.js"
import type { TextModel } from "../embeddings/models.js"
import type { SendGuard } from "../sends/guard.js"
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
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "embed-")), "m.db") })
  await store.saveChats(account, [
    { id: "9", title: "Group", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
  ])
  await store.saveMessages(account, "9", messages, { via: "history" })
  const deps = storedDeps({ provider: "test", app: { command: "chat" } } as Messenger, store, account, {} as SendGuard)
  const conversations = conversationsService(deps)
  if (build) await conversations.build("9")
  return { store, embeddings: embeddingsService(deps), conversations }
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

describe("derived index freshness — today's behaviour, known gaps", () => {
  const edited = (id: string, text: string): Message => ({
    ...message(id, text),
    editedAt: "2026-10-05T00:00:00.000Z",
  })

  it("returns a conversation by meaning for text that was edited away (stale, known gap)", async () => {
    const { store, embeddings, conversations } = await setUp()
    await embeddings.embed("9", { model: "tiny", threads: 1 })
    await store.saveMessages(account, "9", [edited("40", "zebra")], { via: "live" })

    const [top] = (await embeddings.search("fish", { model: "tiny", limit: 3 })).hits
    expect(top).toMatchObject({ summary: { firstMessageId: "40" }, chunk: { firstMessageId: "40" }, by: ["meaning"] })
    expect(top?.score).toBeCloseTo(1)
    const evidence = await conversations.show({ chat: "9", message: "40" })
    expect(evidence.messages.map(({ text }) => text)).toEqual(["zebra"])

    expect(await embeddings.status("9", "tiny")).toMatchObject({ chunks: 3, embedded: 3, left: 0 })
    expect(await embeddings.embed("9", { model: "tiny", threads: 1 })).toMatchObject({ embedded: 0, skipped: 0 })

    await conversations.build("9")
    expect(await embeddings.status("9", "tiny")).toMatchObject({ chunks: 3, embedded: 2, left: 1 })
    await store.close()
  })

  it("returns a conversation by meaning for a message deleted after embedding (stale, known gap)", async () => {
    const { store, embeddings, conversations } = await setUp()
    await embeddings.embed("9", { model: "tiny", threads: 1 })
    await store.markDeleted(account, ["40"], { chatId: "9" })

    const [top] = (await embeddings.search("fish", { model: "tiny", limit: 3 })).hits
    expect(top).toMatchObject({ summary: { firstMessageId: "40" }, by: ["meaning"] })
    expect(top?.score).toBeCloseTo(1)
    expect((await conversations.show({ chat: "9", message: "40" })).messages).toEqual([])
    expect(await embeddings.status("9", "tiny")).toMatchObject({ left: 0 })

    await conversations.build("9")
    expect(await embeddings.status("9", "tiny")).toMatchObject({ chunks: 2, embedded: 2, left: 0 })
    const after = (await embeddings.search("fish", { model: "tiny", limit: 3 })).hits
    expect(after.map(({ summary }) => summary.firstMessageId)).not.toContain("40")
    await store.close()
  })

  it("drops a word match on a message saved after the build, with no pending count anywhere (missing, known gap)", async () => {
    const { store, embeddings, conversations } = await setUp()
    await embeddings.embed("9", { model: "tiny", threads: 1 })
    const builtAt = (await store.conversationState(account, "9"))?.builtAt
    await store.saveMessages(account, "9", [message("120", "zebra")], { via: "live" })

    const { hits } = await embeddings.search("zebra", { model: "tiny", limit: 5 })
    expect(hits.filter(({ by }) => by.includes("words"))).toEqual([])
    expect(hits.map(({ chunk }) => chunk.lastMessageId)).not.toContain("120")
    await expect(conversations.show({ chat: "9", message: "120" })).rejects.toThrow("is in no conversation of chat 9")
    expect(await embeddings.status("9", "tiny")).toMatchObject({ chunks: 3, left: 0 })
    expect((await store.conversationState(account, "9"))?.builtAt).toBe(builtAt)

    await conversations.build("9")
    const rebuilt = (await embeddings.search("zebra", { model: "tiny", limit: 5 })).hits
    expect(rebuilt.find(({ by }) => by.includes("words"))).toMatchObject({
      summary: { firstMessageId: "120" },
      score: null,
      by: ["words"],
    })
    await store.close()
  })

  it("flags only a chat with no vector of the model, not one missing some (partial, known gap)", async () => {
    const { store, embeddings, conversations } = await setUp()
    await embeddings.embed("9", { model: "tiny", threads: 1 })
    await embeddings.embed("9", { model: "tiny-2", threads: 1 })
    await store.saveMessages(account, "9", [message("120", "zebra")], { via: "live" })
    await conversations.build("9")
    await embeddings.embed("9", { model: "tiny", threads: 1 })

    const found = await embeddings.search("zebra", { model: "tiny-2", limit: 5 })
    expect(found.embeddedOnlyElsewhere).toEqual([])
    expect(found.hits.find(({ summary }) => summary.firstMessageId === "120")).toMatchObject({
      score: null,
      by: ["words"],
    })
    expect(await embeddings.status("9", "tiny-2")).toMatchObject({ chunks: 4, embedded: 3, left: 1 })
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

  it("refuses a word-only search when the model is not downloaded (no fallback, known gap)", async () => {
    const { store, embeddings } = await setUp()
    await expect(embeddings.search("zebra", { model: "e5-small", limit: 5 })).rejects.toThrow(
      "chat models text download e5-small",
    )
    await store.close()
  })
})
