import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTaskService } from "@wirecat/cli-tasks"
import { afterEach, describe, expect, it } from "vitest"
import { formatLocator } from "../domain/locator.js"
import { type MessageStore, openStore } from "./store.js"

const key = { provider: "telegram", account: "500" }
const other = { ...key, account: "501" }
const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})
const fixture = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "knowledge-")), "store.db")
  let clock = Date.parse("2026-10-08T10:00:00Z")
  const store = await openStore({ path, now: () => clock })
  opened.push(store)
  for (const account of [key, other]) {
    await store.saveChats(account, [
      { id: "7", title: "Synthetic", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
    ])
    await store.saveMessages(
      account,
      "7",
      [
        {
          id: "42",
          chatId: "7",
          senderId: null,
          senderName: null,
          timestamp: new Date(clock).toISOString(),
          editedAt: null,
          text: "Source budget plan",
          outgoing: true,
          attachments: [],
          replyTo: null,
          forwardedFrom: null,
          reactions: null,
        },
      ],
      { via: "test" },
    )
  }
  const locator = formatLocator({ ...key, chat: "7", message: "42" })
  const target = { type: "message" as const, locator }
  const tasks = createTaskService({ store: store.tasks, now: () => new Date(clock) })
  const task = (
    await tasks.add({
      source: locator,
      sourceKind: "message",
      account: `${key.provider}:${key.account}`,
      group: "7",
      kind: "request",
      origin: "owner",
    })
  ).task
  return {
    store,
    path,
    locator,
    target,
    tasks,
    task,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

describe("cross-source knowledge metadata", () => {
  it("shares contact annotations with existing private note commands and preserves their IDs", async () => {
    const f = await fixture()
    await f.store.savePeople(key, [{ id: "101", name: "Rin Synthetic" }])
    const legacy = await f.store.addContactNote(key, "101", "Existing private note")
    expect(await f.store.knowledge.annotation(key, legacy.id)).toMatchObject({
      target: { type: "contact", id: "101" },
      text: legacy.text,
    })
    const newer = await f.store.knowledge.addAnnotation(key, { type: "contact", id: "101" }, "New owner note")
    expect((await f.store.privateContact(key, "101")).notes.map((note) => note.id).sort()).toEqual(
      [legacy.id, newer.id].sort(),
    )
    expect(await f.store.editContactNote(key, "101", newer.id, "Edited through existing API", 1)).toMatchObject({
      revision: 2,
    })
    expect(await f.store.knowledge.editAnnotation(key, legacy.id, "Edited through Memo API", 1)).toMatchObject({
      revision: 2,
    })
    expect((await f.store.knowledge.annotations(key, { target: { type: "contact", id: "101" } })).items).toHaveLength(2)
    await f.store.removeContactNote(key, "101", newer.id)
    await f.store.knowledge.removeAnnotation(key, legacy.id)
    expect((await f.store.privateContact(key, "101")).notes).toEqual([])
    expect(await f.store.knowledge.taskIds(key, { sources: [f.locator], state: "open", limit: 1 })).toEqual({
      items: [f.task.id],
      hasMore: false,
    })
    await expect(f.store.knowledge.taskIds(key, { limit: 0 })).rejects.toMatchObject({ code: "validation_error" })
    await f.store.knowledge.addTags(key, f.target, ["budget"])
    expect(await f.store.tags(key, { tag: "budget" })).toHaveLength(1)
  })
  it("retains multiple revisioned user annotations after source deletion and store reopening", async () => {
    const f = await fixture()
    const note = await f.store.knowledge.addAnnotation(key, f.target, "Owner budget assessment")
    await f.store.knowledge.addAnnotation(key, f.target, "Second independent note")
    expect((await f.store.knowledge.annotations(key, { search: "budget", limit: 1 })).items).toEqual([note])
    expect(await f.store.knowledge.annotations(key, { limit: 1 })).toMatchObject({ hasMore: true })
    expect(await f.store.knowledge.annotation(other, note.id)).toEqual(note)
    await expect(f.store.knowledge.addAnnotation(other, f.target, "Wrong account")).rejects.toMatchObject({
      code: "validation_error",
    })
    expect(await f.store.knowledge.editAnnotation(key, note.id, "Updated owner assessment", 1)).toMatchObject({
      revision: 2,
    })
    await expect(f.store.knowledge.editAnnotation(key, note.id, "Stale", 1)).rejects.toMatchObject({
      code: "validation_error",
    })
    await f.store.markDeleted(key, ["42"], { chatId: "7" })
    expect(await f.store.knowledge.annotation(key, note.id)).toMatchObject({
      text: "Updated owner assessment",
      targetState: "deleted",
    })
    expect(await f.store.message(key, "42", { chatId: "7" })).toBeUndefined()
    const reopened = await openStore({ path: f.path })
    opened.push(reopened)
    expect(await reopened.knowledge.annotation(key, note.id)).toMatchObject({ targetState: "deleted", revision: 2 })
    await reopened.knowledge.removeAnnotation(key, note.id)
    await expect(reopened.knowledge.annotation(key, note.id)).rejects.toMatchObject({ code: "not_found" })
  })

  it("labels stable tasks and canonical persons without changing source text or identity scope", async () => {
    const f = await fixture()
    const target = { type: "task" as const, id: f.task.id }
    expect(await f.store.knowledge.addTags(key, target, ["Follow-Up", "follow-up"])).toEqual(["follow-up"])
    expect(await f.store.knowledge.addTags(key, target, ["follow-up"])).toEqual([])
    expect(await f.store.knowledge.tags(other, target)).toEqual([])
    expect(await f.store.knowledge.removeTags(key, target, ["follow-up"])).toEqual(["follow-up"])
    await expect(f.store.knowledge.addTags(other, target, ["work"])).rejects.toMatchObject({ code: "not_found" })
    await f.store.savePeople(key, [{ id: "101", name: "Rin Synthetic" }])
    const person = await f.store.personOf({ provider: key.provider, id: "101" })
    const entity = await f.store.knowledge.addEntity(key, "organization", "Synthetic Studio")
    const relation = await f.store.knowledge.relate(key, {
      from: `person:${person?.uid}`,
      to: `entity:${entity.id}`,
      kind: "member-of",
      role: "author",
    })
    expect(await f.store.knowledge.relate(key, { from: relation.from, to: relation.to, kind: "member-of" })).toEqual(
      relation,
    )
    expect(await f.store.knowledge.relations(other)).toEqual([relation])
    expect(await f.store.knowledge.relations(key, relation.from)).toEqual([relation])
    const proposal = await f.store.knowledge.relate(key, {
      from: relation.to,
      to: relation.from,
      kind: "related-to",
      confirmed: false,
      provenance: "synthetic weak rule",
    })
    expect(proposal).toMatchObject({ confirmed: false, confidenceCategory: "weak" })
    expect(await f.store.knowledge.confirmRelation(key, proposal.id)).toMatchObject({
      confirmed: true,
      confidenceCategory: "owner-confirmed",
    })
    await f.store.knowledge.removeRelation(key, proposal.id)
    await f.store.knowledge.removeRelation(key, relation.id)
    expect(await f.store.knowledge.relations(key)).toEqual([])
  })

  it("leases due reminders, rejects stale receipts, survives restart and cancels closed tasks", async () => {
    const f = await fixture()
    const due = "2026-10-08T09:00:00Z"
    const scheduled = await f.store.knowledge.schedule(key, f.task.id, due, "Europe/Madrid")
    expect(await f.store.knowledge.schedule(key, f.task.id, due, "Europe/Madrid")).toEqual(scheduled)
    await expect(f.store.knowledge.schedule(key, f.task.id, due, "Unknown/Zone")).rejects.toMatchObject({
      code: "validation_error",
    })
    const [first] = await f.store.knowledge.claimReminders(key, { leaseMs: 1000 })
    expect(first).toMatchObject({ state: "leased" })
    expect(await f.store.knowledge.claimReminders(key)).toEqual([])
    f.advance(1001)
    const [retry] = await f.store.knowledge.claimReminders(key)
    expect(retry?.receipt).not.toEqual(first?.receipt)
    await expect(
      f.store.knowledge.acknowledgeReminder(key, scheduled.id, first?.receipt as string),
    ).rejects.toMatchObject({ code: "validation_error" })
    const delivered = await f.store.knowledge.acknowledgeReminder(key, scheduled.id, retry?.receipt as string)
    expect(await f.store.knowledge.acknowledgeReminder(key, scheduled.id, retry?.receipt as string)).toEqual(delivered)
    const reopened = await openStore({ path: f.path })
    opened.push(reopened)
    expect(await reopened.knowledge.claimReminders(key)).toEqual([])
    await f.store.knowledge.snoozeReminder(key, scheduled.id, due, delivered.revision)
    await f.tasks.close(f.task.id, { as: "done", by: "owner" })
    expect((await f.store.knowledge.reminders(key))[0]).toMatchObject({ state: "cancelled" })
    expect(await f.store.knowledge.claimReminders(key)).toEqual([])
  })
})
