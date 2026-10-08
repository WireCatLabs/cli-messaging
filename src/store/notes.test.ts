import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTaskService } from "@leemour/cli-tasks"
import { afterEach, describe, expect, it } from "vitest"
import { storeOnlyDeps } from "../services/deps.js"
import { tasksService } from "../services/tasks.js"
import { MIGRATIONS, migrate } from "./migrations.js"
import { openCache } from "./open.js"
import { notesToCopy } from "./sqlite/notes-copy.js"
import { taskStoreOver } from "./sqlite/tasks.js"
import { type MessageStore, openStore } from "./store.js"

const telegram = { provider: "telegram", account: "500" }
const vault = "/synthetic/vault"
const noteLocator = `msg:notes/${encodeURIComponent(vault)}/Projects/${encodeURIComponent("Projects/plan.md")}`
const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})
const fresh = () => join(mkdtempSync(join(tmpdir(), "notes-")), "store.db")
const open = async (path: string, now = () => Date.parse("2026-10-08T12:00:00Z")) => {
  const store = await openStore({ path, now })
  opened.push(store)
  return store
}

/** What a build on version 24 left: notes as messages, annotations, relations, entities and their tags. */
const version24File = async () => {
  const path = fresh()
  const db = await openCache(path)
  migrate(db, { migrations: MIGRATIONS.filter((migration) => migration.version < 25) })
  db.exec(`INSERT INTO accounts(pk,provider,native_id,name,created_at) VALUES(1,'notes','${vault}','vault',0),
    (2,'telegram','500','Owner',0),(3,'telegram','501','Second',0)`)
  db.exec(
    `INSERT INTO chats(pk,account_pk,native_id,kind,updated_at) VALUES(1,1,'Projects','saved',0),(2,2,'7','group',0)`,
  )
  db.exec(`INSERT INTO messages(pk,chat_pk,account_pk,native_id,sent_at,edited_at,deleted_at,text,ingested_at,ingested_via) VALUES
    (1,1,1,'Projects/plan.md',1000,2000,NULL,'plan\n\nBudget for [[Rin Example]]',0,'cli-memo'),
    (2,1,1,'Projects/gone.md',1000,NULL,3000,'',0,'cli-memo'),
    (3,2,2,'42',1000,NULL,NULL,'Synthetic message',0,'history')`)
  db.exec(`INSERT INTO message_revisions(message_pk,text,captured_at) VALUES(1,'plan\n\nFirst draft',1500)`)
  db.exec(`INSERT INTO tags(taggable_type,taggable_pk,tag,created_at,manual) VALUES('message',1,'budget',0,1)`)
  db.exec(
    `INSERT INTO identities(pk,provider,native_id,name,first_seen_at,updated_at) VALUES(1,'telegram','101','Rin Example',0,0)`,
  )
  db.exec(`INSERT INTO persons(pk,uid,name,created_at,updated_at) VALUES(1,'P1','Rin Example',0,0)`)
  db.exec(
    `INSERT INTO identity_links(identity_pk,person_pk,method,confidence,linked_at,linked_by) VALUES(1,1,'initial',1,0,'ingest')`,
  )
  db.exec(`INSERT INTO account_identities(account_pk,identity_pk,first_seen_at) VALUES(2,1,0)`)
  db.exec(`INSERT INTO knowledge_targets(pk,account_pk,type,reference,created_at) VALUES
    (1,1,'message','${noteLocator}',0),(2,2,'message','msg:telegram/500/7/42',0),(3,2,'chat','7',0)`)
  db.exec(`INSERT INTO tags(taggable_type,taggable_pk,tag,created_at,manual) VALUES('knowledge',1,'review',0,1)`)
  db.exec(`INSERT INTO annotations(uid,account_pk,target_type,target_pk,text,revision,created_at,updated_at,authored_by) VALUES
    ('A1',2,'contact',1,'Contact note',2,10,20,'owner'),
    ('A2',1,'source',1,'About the plan',1,11,11,'owner'),
    ('A3',2,'source',2,'About a message',1,12,12,'owner'),
    ('A4',2,'source',3,'About a chat',1,13,13,'owner')`)
  db.exec(
    `INSERT INTO knowledge_entities(uid,account_pk,kind,name,created_at) VALUES('E1',2,'organization','Synthetic Studio',0)`,
  )
  db.exec(`INSERT INTO knowledge_relations(uid,account_pk,from_ref,to_ref,kind,role,created_at,confirmed,provenance) VALUES
    ('R1',2,'person:P1','entity:E1','member-of','author',0,1,NULL),
    ('R2',3,'person:P1','entity:E1','member-of',NULL,1,1,NULL),
    ('R3',2,'entity:E1','person:P1','related-to',NULL,2,0,'synthetic rule')`)
  db.close()
  return path
}

describe("version 25: notes as their own records", () => {
  it("copies a version 24 file's notes, annotations, relations and entities, losing nothing", async () => {
    const store = await open(await version24File())
    const [folder] = await store.notes.folders()
    expect(folder).toMatchObject({ name: "vault", format: "obsidian", pendingPath: vault })

    const files = await store.notes.notes({ source: "file" })
    expect(files.items).toHaveLength(1)
    const plan = files.items[0]
    expect(plan).toMatchObject({
      folderId: folder?.id,
      path: "Projects/plan.md",
      title: "plan",
      text: "Budget for [[Rin Example]]",
      createdAt: new Date(1000).toISOString(),
      updatedAt: new Date(2000).toISOString(),
    })
    expect(await store.knowledge.tags(telegram, { type: "note", id: plan?.id as string })).toEqual(["budget", "review"])

    const about = await store.notes.links({ to: `note:${plan?.id}` })
    expect(about.map((link) => link.from)).toEqual(["note:A2"])
    expect((await store.notes.links({ from: "note:A1" }))[0]?.to).toBe("contact:telegram/101")
    expect((await store.notes.links({ from: "note:A3" }))[0]?.to).toBe("msg:telegram/500/7/42")
    expect((await store.notes.links({ from: "note:A4" }))[0]?.to).toBe("chat:telegram/500/7")
    expect(await store.notes.note("A1")).toMatchObject({ source: "internal", text: "Contact note", revision: 2 })
    expect((await store.privateContact(telegram, "101")).notes.map((note) => note.id)).toEqual(["A1"])

    expect(await store.notes.entities()).toMatchObject([{ id: "E1", name: "Synthetic Studio" }])
    const relations = await store.knowledge.relations(telegram)
    expect(relations.map((relation) => relation.id)).toEqual(["R1", "R3"])
    expect(relations[1]).toMatchObject({ confirmed: false, provenance: "synthetic rule" })
    expect((await store.notes.links({ from: "entity:E1" }))[0]?.origin).toBe("suggested")
  })

  it("copies once, catches up what an older build writes later, and never brings back what was removed", async () => {
    const path = await version24File()
    const first = await open(path)
    expect(await first.notes.notes({ limit: 500 })).toMatchObject({ hasMore: false })
    const count = (await first.notes.notes({ limit: 500 })).items.length
    await first.knowledge.removeAnnotation(telegram, "A3")
    await first.close()
    opened.splice(opened.indexOf(first), 1)

    const db = await openCache(path)
    expect(notesToCopy(db)).toBe(false)
    db.exec(`INSERT INTO annotations(uid,account_pk,target_type,target_pk,text,revision,created_at,updated_at,authored_by)
      VALUES('A5',2,'contact',1,'Written by an older build',1,30,30,'owner')`)
    expect(notesToCopy(db)).toBe(true)
    db.close()

    const second = await open(path)
    const items = (await second.notes.notes({ limit: 500 })).items
    expect(items).toHaveLength(count)
    expect(items.map((note) => note.id)).toContain("A5")
    expect(items.map((note) => note.id)).not.toContain("A3")
  })

  it("hands a pre-25 folder's path over once", async () => {
    const store = await open(await version24File())
    const [folder] = await store.notes.folders()
    expect(await store.notes.claimFolderPath(folder?.id as string)).toEqual({ id: folder?.id, path: vault })
    expect(await store.notes.claimFolderPath(folder?.id as string)).toEqual({ id: folder?.id, path: null })
  })
})

describe("people named in notes", () => {
  const withNote = async (before: (store: MessageStore) => Promise<void> = async () => {}) => {
    const store = await open(fresh())
    await store.saveAccount(telegram, { name: "Owner" })
    await before(store)
    const folder = await store.notes.addFolder({ name: "Vault" })
    const { note } = await store.notes.saveFileNote({
      folderId: folder.id,
      path: "meeting.md",
      title: "meeting",
      text: "With [[Rin Example]] and [[Rinny]]",
    })
    await store.notes.replaceFileLinks(note.id, [
      { kind: "links-to", targetText: "Rin Example" },
      { kind: "links-to", targetText: "@Rinny" },
    ])
    return { store, note }
  }
  const targets = async (store: MessageStore, noteId: string) =>
    (await store.notes.links({ from: `note:${noteId}` }))
      .map((link) => [link.targetText, link.to])
      .sort(([a], [b]) => String(b).localeCompare(String(a)))

  it("resolves a link the moment a person with that name appears, and not before", async () => {
    const { store, note } = await withNote()
    expect(await targets(store, note.id)).toEqual([
      ["Rin Example", null],
      ["@Rinny", null],
    ])
    await store.savePeople(telegram, [{ id: "101", name: "rin example" }])
    const person = await store.personOf({ provider: "telegram", id: "101" })
    expect(await targets(store, note.id)).toEqual([
      ["Rin Example", `person:${person?.uid}`],
      ["@Rinny", null],
    ])
  })

  it("leaves a name two people share unresolved until they are linked as one", async () => {
    const { store, note } = await withNote(async (store) => {
      await store.saveAccount({ provider: "max", account: "9" }, { name: "Owner" })
      await store.savePeople(telegram, [{ id: "101", name: "Rin Example" }])
      await store.savePeople({ provider: "max", account: "9" }, [{ id: "202", name: "Rin Example" }])
    })
    expect((await targets(store, note.id))[0]).toEqual(["Rin Example", null])
    const merged = await store.linkIdentities(
      { provider: "telegram", id: "101" },
      { provider: "max", id: "202" },
      { method: "manual", by: "owner" },
    )
    expect((await targets(store, note.id))[0]).toEqual(["Rin Example", `person:${merged.uid}`])
  })

  it("resolves a link by a local alias and by a username", async () => {
    const { store, note } = await withNote()
    await store.savePeople(telegram, [{ id: "101", name: "Somebody Else", username: "rinny" }])
    const person = await store.personOf({ provider: "telegram", id: "101" })
    expect((await targets(store, note.id))[1]).toEqual(["@Rinny", `person:${person?.uid}`])
    await store.savePeople(telegram, [{ id: "102", name: "Another Person" }])
    await store.setContactAlias(telegram, "102", "Rin Example")
    const aliased = await store.personOf({ provider: "telegram", id: "102" })
    expect((await targets(store, note.id))[0]).toEqual(["Rin Example", `person:${aliased?.uid}`])
  })
})

describe("the notes store", () => {
  it("keeps a file note's earlier text, tags it, and drops its tags when the file goes", async () => {
    const store = await open(fresh())
    await store.saveAccount(telegram, { name: "Owner" })
    const folder = await store.notes.addFolder({ name: "Vault", format: "markdown" })
    const input = { folderId: folder.id, path: "a.md", title: "a", text: "One", contentHash: "h1" }
    const { note } = await store.notes.saveFileNote(input)
    expect((await store.notes.saveFileNote(input)).changed).toBe(false)
    const edited = await store.notes.saveFileNote({ ...input, text: "Two", contentHash: "h2" })
    expect(edited).toMatchObject({ changed: true, note: { id: note.id, revision: 2, text: "Two" } })
    expect(await store.knowledge.addTags(telegram, { type: "note", id: note.id }, ["Work"])).toEqual(["work"])
    expect(await store.notes.deleteFileNotes(folder.id, ["a.md"])).toBe(1)
    expect(await store.knowledge.tags(telegram, { type: "note", id: note.id })).toEqual([])
    expect(await store.notes.note(note.id)).toMatchObject({ text: "", deletedAt: expect.any(String) })
    await expect(store.notes.removeNote(note.id)).rejects.toMatchObject({ code: "validation_error" })
  })

  it("writes internal notes about anything, guards stale edits, and keeps the owner's links on re-import", async () => {
    const store = await open(fresh())
    const entity = await store.notes.addEntity("project", "Lighthouse")
    const note = await store.notes.addNote({ text: "Budget is tight", about: [`entity:${entity.id}`] })
    expect((await store.notes.notes({ about: `entity:${entity.id}` })).items.map((one) => one.id)).toEqual([note.id])
    expect(await store.notes.editNote(note.id, "Budget is fine", 1)).toMatchObject({ revision: 2 })
    await expect(store.notes.editNote(note.id, "Stale", 1)).rejects.toMatchObject({ code: "validation_error" })

    const folder = await store.notes.addFolder({ name: "Vault" })
    const { note: file } = await store.notes.saveFileNote({ folderId: folder.id, path: "x.md", title: "x", text: "x" })
    const owner = await store.notes.addLink({ from: `note:${file.id}`, to: `entity:${entity.id}`, kind: "about" })
    await store.notes.replaceFileLinks(file.id, [{ kind: "links-to", to: `note:${note.id}`, anchor: "#Budget" }])
    await store.notes.replaceFileLinks(file.id, [{ kind: "links-to", to: `note:${note.id}` }])
    expect(
      (await store.notes.links({ from: `note:${file.id}` })).map((link) => [link.origin, link.anchor]).sort(),
    ).toEqual([
      ["file", null],
      ["owner", null],
    ])
    await store.notes.removeLink(owner.id)
    await store.notes.removeNote(note.id)
    await expect(store.notes.note(note.id)).rejects.toMatchObject({ code: "not_found" })
    expect(await store.notes.links({ from: `note:${note.id}` })).toEqual([])
    await expect(store.notes.addLink({ from: "nothing", to: "note:x", kind: "about" })).rejects.toMatchObject({
      code: "validation_error",
    })
    await expect(store.notes.addLink({ from: `note:${file.id}`, kind: "about" })).rejects.toMatchObject({
      code: "validation_error",
    })
  })
})

it("resolves migrated task sources to current native notes without duplicating a closed task", async () => {
  const path = await version24File()
  const db = await openCache(path)
  const legacy = createTaskService({ store: taskStoreOver(db) })
  const { task } = await legacy.add({
    source: noteLocator,
    sourceKind: "note",
    account: `notes:${vault}`,
    group: "Projects",
    kind: "request",
    origin: "owner",
  })
  await legacy.close(task.id, { as: "done", by: "owner" })
  db.close()
  const store = await open(path)
  const note = await store.notes.resolveNote(noteLocator)
  expect(note).toBeDefined()
  expect(await store.notes.noteReferences(note?.id as string)).toContain(noteLocator)
  const tasks = tasksService(
    storeOnlyDeps(
      store,
      { provider: "notes", account: vault },
      { app: { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1.0.0" } },
    ),
  )
  await store.notes.saveFileNote({
    folderId: note?.folderId as string,
    path: "Projects/plan.md",
    title: "New title",
    text: "Current native text",
  })
  expect((await tasks.list({ state: "done" }))[0]).toMatchObject({
    source: `note:${note?.id}`,
    note: { text: "Current native text" },
  })
  expect(await tasks.add(`note:${note?.id}`, "request", "owner")).toMatchObject({
    created: false,
    task: { id: task.id, state: "done" },
  })
  await store.notes.renameFileNote(note?.folderId as string, "Projects/plan.md", "renamed.md")
  expect((await tasks.list({ state: "done" }))[0]?.note?.text).toBe("Current native text")
  await expect(tasks.add(noteLocator, "request", "owner")).rejects.toMatchObject({ code: "not_found" })
  await store.notes.deleteFileNotes(note?.folderId as string, ["renamed.md"])
  expect((await tasks.list({ state: "done" }))[0]?.note).toBeNull()
})
