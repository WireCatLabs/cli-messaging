import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTaskService } from "@leemour/cli-tasks"
import { afterEach, describe, expect, it } from "vitest"
import { searchNotesQuery } from "../services/notes-search.js"
import { openCache } from "./open.js"
import { type AccountKey, type MessageStore, openStore } from "./store.js"

const telegram: AccountKey = { provider: "telegram", account: "500" }
const live: MessageStore[] = []
afterEach(async () => {
  for (const store of live.splice(0)) await store.close()
})

const open = async (path = join(mkdtempSync(join(tmpdir(), "owner-labels-")), "store.db")) => {
  const store = await openStore({ path })
  live.push(store)
  return { store, path }
}

const fileNote = async (store: MessageStore, folderId: string, path: string) =>
  (await store.notes.saveFileNote({ folderId, path, title: path, text: `about ${path}` })).note

const tagged = async (store: MessageStore, tag: string) =>
  (await searchNotesQuery(store, { text: `tag:${tag}`, limit: 20, timezone: "UTC" })).items
    .map(({ note }) => note.path)
    .sort()

describe("labels that belong to no account (version 27)", () => {
  it("labels a person, an entity and a task without naming an account, and relates them", async () => {
    const { store } = await open()
    await store.saveAccount(telegram, { name: null })
    await store.savePeople(telegram, [{ id: "101", name: "Rin Synthetic" }])
    const person = await store.personOf({ provider: "telegram", id: "101" })
    const entity = await store.notes.addEntity("organization", "Synthetic Studio")
    const task = (
      await createTaskService({ store: store.tasks }).add({
        source: "msg:telegram/500/7/42",
        sourceKind: "message",
        account: "telegram:500",
        group: "7",
        kind: "request",
        origin: "owner",
      })
    ).task

    for (const target of [
      { type: "person" as const, id: person?.uid as string },
      { type: "entity" as const, id: entity.id },
      { type: "task" as const, id: task.id },
    ]) {
      expect(await store.knowledge.addTags(null, target, ["Client"])).toEqual(["client"])
      expect(await store.knowledge.tags(null, target)).toEqual(["client"])
      expect(await store.knowledge.tags(telegram, target)).toEqual(["client"])
    }
    const relation = await store.knowledge.relate(null, {
      from: `person:${person?.uid}`,
      to: `entity:${entity.id}`,
      kind: "member-of",
    })
    expect(await store.knowledge.relations(null, `entity:${entity.id}`)).toEqual([relation])
    expect((await store.knowledge.entities(null)).map(({ id }) => id)).toEqual([entity.id])
  })

  it("still needs the account for a chat or a contact", async () => {
    const { store } = await open()
    await expect(store.knowledge.addTags(null, { type: "chat", id: "7" }, ["x"])).rejects.toMatchObject({
      code: "validation_error",
    })
    await expect(store.knowledge.addTags(null, { type: "contact", id: "101" }, ["x"])).rejects.toMatchObject({
      code: "validation_error",
    })
  })

  it("looks a person up by the uid a person: reference holds", async () => {
    const { store } = await open()
    await store.saveAccount(telegram, { name: null })
    await store.savePeople(telegram, [{ id: "101", name: "Rin Synthetic" }])
    const person = await store.personOf({ provider: "telegram", id: "101" })
    expect(await store.personByUid(person?.uid as string)).toEqual(person)
    expect(await store.personByUid("nobody")).toBeUndefined()
  })
})

describe("a note's tags remember who stated them", () => {
  it("replaces a file's tags on import and keeps the owner's, even one the file drops", async () => {
    const { store } = await open()
    const folder = await store.notes.addFolder({ name: "Vault" })
    const note = await fileNote(store, folder.id, "plan.md")

    await store.notes.replaceFileTags(note.id, ["budget", "review"])
    await store.knowledge.addTags(null, { type: "note", id: note.id }, ["review", "mine"])
    expect(await store.notes.noteTags(note.id)).toEqual([
      { tag: "budget", origin: "file" },
      { tag: "mine", origin: "owner" },
      { tag: "review", origin: "owner" },
    ])

    await store.notes.replaceFileTags(note.id, ["budget"])
    await store.notes.replaceFileTags(note.id, [])
    expect(await store.notes.noteTags(note.id)).toEqual([
      { tag: "mine", origin: "owner" },
      { tag: "review", origin: "owner" },
    ])
  })
})

describe("labels on a notes folder or subfolder", () => {
  it("labels every note under the subfolder, at any depth, and none beside it", async () => {
    const { store } = await open()
    const folder = await store.notes.addFolder({ name: "Vault" })
    for (const path of ["Projects/a.md", "Projects/deep/b.md", "Projects-old/c.md", "d.md"])
      await fileNote(store, folder.id, path)

    await store.knowledge.addTags(null, { type: "folder", id: folder.id, path: "/Projects/" }, ["work"])
    expect(await tagged(store, "work")).toEqual(["Projects/a.md", "Projects/deep/b.md"])

    await store.knowledge.addTags(null, { type: "folder", id: folder.id }, ["vault"])
    expect(await tagged(store, "vault")).toEqual(["Projects-old/c.md", "Projects/a.md", "Projects/deep/b.md", "d.md"])

    await store.knowledge.removeTags(null, { type: "folder", id: folder.id, path: "Projects" }, ["work"])
    expect(await tagged(store, "work")).toEqual([])
  })

  it("lists labelled notes and folders with where each label came from", async () => {
    const { store } = await open()
    const folder = await store.notes.addFolder({ name: "Vault" })
    const note = await fileNote(store, folder.id, "Projects/a.md")
    await store.notes.replaceFileTags(note.id, ["budget"])
    await store.knowledge.addTags(null, { type: "folder", id: folder.id, path: "Projects" }, ["work"])

    const all = await store.knowledge.labelled(null)
    expect(all.items.map(({ target, labels }) => ({ target, labels }))).toEqual([
      { target: { type: "note", id: note.id }, labels: [{ tag: "budget", origin: "file" }] },
      { target: { type: "folder", id: folder.id, path: "Projects" }, labels: [{ tag: "work", origin: "owner" }] },
    ])
    expect((await store.knowledge.labelled(null, { type: "folder" })).items).toHaveLength(1)
    expect((await store.knowledge.labelled(null, { tag: "budget" })).items).toHaveLength(1)
  })
})

describe("labels from before version 27", () => {
  it("are copied once — to the person, the note and the notes subfolder — and a removed one stays removed", async () => {
    const { store, path } = await open()
    await store.saveAccount(telegram, { name: null })
    await store.savePeople(telegram, [{ id: "101", name: "Rin Synthetic" }])
    const person = await store.personOf({ provider: "telegram", id: "101" })
    const folder = await store.notes.addFolder({ name: "Vault" })
    const note = await fileNote(store, folder.id, "Projects/a.md")
    const oldVault: AccountKey = { provider: "notes", account: "/old/vault" }
    await store.saveAccount(oldVault, { name: "vault" })
    await store.saveChats(oldVault, [
      {
        id: "Projects",
        title: "Projects",
        kind: "saved",
        unreadCount: null,
        lastMessageAt: null,
        participantsCount: null,
      },
    ])
    await store.close()
    live.splice(0)

    const db = await openCache(path)
    db.prepare(
      "UPDATE note_folders SET account_pk = (SELECT pk FROM accounts WHERE provider = 'notes') WHERE id = ?",
    ).run(folder.id)
    db.prepare(
      "INSERT INTO knowledge_targets (pk, account_pk, type, reference, created_at) VALUES (1, 1, 'person', ?, 0)",
    ).run(person?.uid as string)
    db.prepare(
      "INSERT INTO knowledge_targets (pk, account_pk, type, reference, created_at) VALUES (2, 1, 'note', ?, 0)",
    ).run(note.id)
    db.exec(`INSERT INTO tags (taggable_type, taggable_pk, tag, created_at, manual) VALUES
      ('knowledge', 1, 'client', 0, 1), ('knowledge', 2, 'review', 0, 1)`)
    db.exec(
      "INSERT INTO tags (taggable_type, taggable_pk, tag, created_at, manual) SELECT 'chat', pk, 'work', 0, 1 FROM chats WHERE native_id = 'Projects'",
    )
    db.exec("DELETE FROM store_settings WHERE key = 'ownerTargetsCopied'")
    db.close()

    const { store: reopened } = await open(path)
    expect(await reopened.knowledge.tags(null, { type: "person", id: person?.uid as string })).toEqual(["client"])
    expect(await reopened.knowledge.tags(null, { type: "note", id: note.id })).toEqual(["review"])
    expect(await tagged(reopened, "work")).toEqual(["Projects/a.md"])

    await reopened.knowledge.removeTags(null, { type: "person", id: person?.uid as string }, ["client"])
    await reopened.close()
    live.splice(0)
    const { store: again } = await open(path)
    expect(await again.knowledge.tags(null, { type: "person", id: person?.uid as string })).toEqual([])
  })
})
