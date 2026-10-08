import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { openStore } from "../store/store.js"
import { storeOnlyDeps } from "./deps.js"
import { tasksService } from "./tasks.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1.0.0" }
const account = { provider: "chat", account: "500" }

it("keeps native note tasks scoped, idempotent and closed, with live previews and no copied text", async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "note-tasks-")), "m.db") })
  try {
    const tasks = tasksService(storeOnlyDeps(store, account, { app }))
    const note = await store.notes.addNote({ text: "Synthetic request", title: "A note" })
    const source = `note:${note.id}`
    const first = await tasks.add(source, "request", "owner")
    expect(first).toMatchObject({
      created: true,
      task: { source, sourceKind: "note", account: "chat:500", message: null, note: { text: "Synthetic request" } },
    })
    expect(await store.tasks.get(first.task.id)).not.toHaveProperty("note")
    await store.notes.editNote(note.id, "Changed request", note.revision)
    expect((await tasks.list())[0]?.note?.text).toBe("Changed request")
    expect((await tasks.add(source, "request", "owner")).task.id).toBe(first.task.id)
    await tasks.close(first.task.id, { as: "done", by: "owner" })
    expect(await tasks.add(source, "request", "owner")).toMatchObject({ created: false, task: { state: "done" } })
    const second = tasksService(storeOnlyDeps(store, { ...account, account: "501" }, { app }))
    expect(await second.list()).toEqual([])
    await expect(second.close(first.task.id, { as: "done", by: "owner" })).rejects.toMatchObject({ code: "not_found" })
    await store.notes.removeNote(note.id)
    expect((await tasks.list({ state: "done" }))[0]).toMatchObject({ id: first.task.id, message: null, note: null })
    await expect(tasks.add(source, "request", "owner")).rejects.toMatchObject({ code: "not_found" })
    await expect(tasks.add("note:missing", "request", "owner")).rejects.toMatchObject({ code: "not_found" })
  } finally {
    await store.close()
  }
})

it("keeps a file task when its source is removed and reads the restored file by stable ID", async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "file-tasks-")), "m.db") })
  try {
    const folder = await store.notes.addFolder({ name: "Synthetic" })
    const { note } = await store.notes.saveFileNote({
      folderId: folder.id,
      path: "plan.md",
      title: "Plan",
      text: "Synthetic file",
    })
    const tasks = tasksService(storeOnlyDeps(store, account, { app }))
    const added = await tasks.add(`note:${note.id}`, "promise", "owner")
    await store.notes.renameFileNote(folder.id, "plan.md", "new.md")
    expect((await tasks.list())[0]?.note?.text).toBe("Synthetic file")
    await store.notes.deleteFileNotes(folder.id, ["new.md"])
    expect((await tasks.list())[0]?.note).toBeNull()
    await expect(tasks.add(`note:${note.id}`, "promise", "owner")).rejects.toMatchObject({ code: "not_found" })
    const restored = await store.notes.saveFileNote({
      folderId: folder.id,
      path: "new.md",
      title: "Plan",
      text: "Restored",
    })
    expect(restored.note.id).toBe(note.id)
    expect(await tasks.add(`note:${note.id}`, "promise", "owner")).toMatchObject({
      created: false,
      task: { id: added.task.id, note: { text: "Restored" } },
    })
  } finally {
    await store.close()
  }
})
