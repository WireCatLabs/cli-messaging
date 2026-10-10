import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { MemoryInput } from "./sqlite/memories.js"
import { type MessageStore, openStore } from "./store.js"

const live: MessageStore[] = []
afterEach(async () => {
  for (const store of live.splice(0)) await store.close()
})
const open = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "memories-")), "store.db") })
  live.push(store)
  return store
}
const agent = { bot: "digest-writer", model: "synthetic-model-1" }

describe("memories", () => {
  it("refuse a memory without its scope or without evidence, writing nothing", async () => {
    const store = await open()
    const note = await store.notes.addNote({ text: "Alice Example prefers mornings" })
    const input: MemoryInput = {
      kind: "preference",
      body: "Alice prefers morning calls",
      scope: "work",
      evidence: [note.ref],
      author: agent,
    }
    await expect(store.memories.add({ ...input, scope: undefined as unknown as "work" })).rejects.toMatchObject({
      code: "validation_error",
      details: { reason: "memory_scope_required" },
    })
    await expect(store.memories.add({ ...input, evidence: [] })).rejects.toMatchObject({
      code: "validation_error",
      details: { reason: "memory_evidence_required" },
    })
    await expect(store.memories.add({ ...input, evidence: ["note:999"] })).rejects.toMatchObject({ code: "not_found" })
    expect(await store.memories.list()).toEqual([])
  })

  it("keep their evidence, author and model, are found by their words, and give way to a newer one", async () => {
    const store = await open()
    const note = await store.notes.addNote({ text: "Bob Sample moved the review to Fridays" })
    const first = await store.memories.add({
      kind: "fact",
      body: "The review is on Fridays",
      scope: "work",
      evidence: [note.ref],
      author: agent,
      confidence: 0.8,
    })
    expect(first).toMatchObject({ status: "proposed", scope: "work", model: "synthetic-model-1", evidence: [note.ref] })
    expect((await store.memories.search("friday")).map(({ id }) => id)).toEqual([first.id])
    expect(await store.memories.search("friday", { scope: "personal" })).toEqual([])

    const newer = await store.memories.add({
      kind: "fact",
      body: "The review is on Mondays",
      scope: "work",
      evidence: [note.ref],
      author: "owner",
      status: "confirmed",
      supersedes: first.ref,
    })
    expect(await store.memories.get(first.ref)).toMatchObject({ status: "superseded" })
    expect(newer).toMatchObject({ status: "confirmed", supersedes: first.ref, lastVerifiedAt: expect.any(String) })
    expect((await store.memories.search("review")).map(({ id }) => id)).toEqual([newer.id])
    expect(await store.memories.indexState()).toMatchObject({ pending: 0 })
  })
})

describe("decisions", () => {
  it("wait as proposed from an agent, hold once accepted, and stop holding when replaced", async () => {
    const store = await open()
    const project = await store.knowledge.addProject({ name: "Lighthouse", type: "work" })
    const note = await store.notes.addNote({ text: "We agreed on Postgres" })
    const memory = await store.memories.add({
      kind: "summary",
      body: "Postgres was chosen",
      scope: "work",
      evidence: [note.ref],
      author: agent,
    })
    const proposed = await store.decisions.add({
      statement: "Use Postgres",
      by: agent,
      project: project.ref,
      evidence: [note.ref],
      createdFrom: memory.ref,
    })
    expect(proposed).toMatchObject({
      status: "proposed",
      confirmedBy: null,
      evidence: [note.ref],
      project: project.ref,
    })
    expect(await store.decisions.accept(proposed.ref)).toMatchObject({
      status: "accepted",
      confirmedBy: { type: "person" },
    })

    const replacement = await store.decisions.add({ statement: "Use SQLite", by: "owner", supersedes: proposed.ref })
    expect(replacement.status).toBe("accepted")
    expect(await store.decisions.get(proposed.ref)).toMatchObject({ status: "superseded" })
    expect((await store.decisions.list({ project: project.ref })).map(({ ref }) => ref)).toEqual([proposed.ref])
    expect(await store.decisions.reverse(replacement.ref)).toMatchObject({ status: "reversed" })
  })
})
