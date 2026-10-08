import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TextModel } from "../embeddings/models.js"
import { type MessageStore, openStore } from "../store/store.js"
import { embedNotes, nearestNotes } from "./notes-search.js"

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
  return { ...real, textModel: (id: string) => (id === "tiny" ? tiny : real.textModel(id)) }
})

const live: MessageStore[] = []
beforeEach(() => {
  const cache = mkdtempSync(join(tmpdir(), "models-"))
  mkdirSync(join(cache, "models", "text"), { recursive: true })
  symlinkSync(
    fileURLToPath(new URL("../embeddings/fixtures/tiny", import.meta.url)),
    join(cache, "models", "text", "tiny"),
  )
  vi.stubEnv("CLI_COMMON_CACHE_DIR", cache)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const store of live.splice(0)) await store.close()
})

const open = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "notes-embed-")), "store.db") })
  live.push(store)
  return store
}

describe("notes by meaning", () => {
  it("embeds every note chunk once, then finds the note nearest in meaning", async () => {
    const store = await open()
    const fish = await store.notes.addNote({ text: "fish fish fish" })
    await store.notes.addNote({ text: "cat dog" })

    expect(await embedNotes(store, { model: "tiny", threads: 1 })).toEqual({ model: "tiny", embedded: 2, left: false })
    expect((await embedNotes(store, { model: "tiny", threads: 1 })).embedded).toBe(0)

    const [best] = await nearestNotes(store, "fish", { model: "tiny", limit: 1, threads: 1 })
    expect(best?.note.id).toBe(fish.id)
  })

  it("stops at maxChunks and says chunks are left", async () => {
    const store = await open()
    await store.notes.addNote({ text: "fish" })
    await store.notes.addNote({ text: "cat" })
    expect(await embedNotes(store, { model: "tiny", maxChunks: 1, threads: 1 })).toMatchObject({
      embedded: 1,
      left: true,
    })
  })

  it("names the download command when the model is missing, and downloads nothing", async () => {
    const store = await open()
    await store.notes.addNote({ text: "fish" })
    await expect(embedNotes(store, { model: "e5-small", command: "memo" })).rejects.toThrow(
      "memo models text download e5-small",
    )
  })
})
