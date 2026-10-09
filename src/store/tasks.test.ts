import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTaskService, type NewTask, type Task } from "@wirecat/cli-tasks"
import { describe, expect, it } from "vitest"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const fresh = () => join(mkdtempSync(join(tmpdir(), "tasks-")), "messages.db")
const openTasks = async (path: string) => {
  const store = await openStore({ path })
  return Object.assign(store.tasks, { close: () => store.close() })
}

const question: NewTask = {
  source: "msg:telegram:100:-1001:42",
  sourceKind: "message",
  account: "telegram:100",
  group: "-1001",
  kind: "question",
  origin: "rule",
}

const at = (iso: string) => new Date(iso)

describe("tasks in the store", () => {
  it("keeps a task across a reopen, closed state, reason and times included", async () => {
    const path = fresh()
    let ids = 0
    const first = await openTasks(path)
    const service = createTaskService({
      store: first,
      now: () => at("2026-10-05T10:00:00Z"),
      newId: () => `t${++ids}`,
    })
    const { task } = await service.add({ ...question, dueAt: at("2026-10-06T00:00:00Z") })
    await service.close(task.id, { as: "dismissed", by: "owner", reason: "no-reply-needed" })
    await first.close()

    const second = await openTasks(path)
    expect(await second.get("t1")).toEqual({
      ...question,
      id: "t1",
      state: "dismissed",
      reason: "no-reply-needed",
      createdAt: at("2026-10-05T10:00:00Z"),
      dueAt: at("2026-10-06T00:00:00Z"),
      closedAt: at("2026-10-05T10:00:00Z"),
      closedBy: "owner",
    } satisfies Task)
    await second.close()
  })

  it("holds the package's rules: one task per source from a rule, another kind by hand", async () => {
    const store = await openTasks(fresh())
    const service = createTaskService({ store })
    const first = await service.add(question)
    await service.close(first.task.id, { as: "dismissed", by: "owner", reason: "no-reply-needed" })

    expect((await service.add(question)).created).toBe(false)
    expect((await service.add({ ...question, kind: "mention" })).created).toBe(false)
    expect((await service.add({ ...question, kind: "promise", origin: "agent" })).created).toBe(true)
    expect((await service.add({ ...question, account: "max:7" })).created).toBe(true)
    expect(await store.findBySource(question.account, question.source)).toHaveLength(2)
    await store.close()
  })

  it("lists by state, group, kind and age", async () => {
    const store = await openTasks(fresh())
    let now = at("2026-10-05T10:00:00Z")
    const service = createTaskService({ store, now: () => now })
    const old = await service.add(question)
    now = at("2026-10-05T12:00:00Z")
    await service.add({ ...question, source: "msg:telegram:100:-1002:7", group: "-1002", kind: "mention" })
    await service.close(old.task.id, { as: "done", by: "owner" })

    const sources = async (filter: Parameters<typeof service.list>[0]) =>
      (await service.list(filter)).map((task) => task.source)
    expect(await sources({ state: "open" })).toEqual(["msg:telegram:100:-1002:7"])
    expect(await sources({ group: "-1001", account: "telegram:100" })).toEqual([question.source])
    expect(await sources({ kind: "mention" })).toEqual(["msg:telegram:100:-1002:7"])
    expect(await sources({ createdBefore: at("2026-10-05T11:00:00Z") })).toEqual([question.source])
    expect(await sources({})).toHaveLength(2)
    await store.close()
  })

  it("has no column that could hold message text", async () => {
    const path = fresh()
    await (await openTasks(path)).close()
    const database = await openCache(path)
    const columns = database
      .prepare("SELECT name FROM pragma_table_info('tasks')")
      .all()
      .map((row) => row.name)
    database.close()

    expect(columns).toEqual([
      "id",
      "source",
      "source_kind",
      "account",
      "group_key",
      "kind",
      "state",
      "reason",
      "origin",
      "created_at",
      "due_at",
      "closed_at",
      "closed_by",
    ])
  })

  it("names an unknown value instead of passing it on", async () => {
    const path = fresh()
    const store = await openTasks(path)
    await store.insert({ ...question, id: "t1", state: "open", createdAt: at("2026-10-05T10:00:00Z") })
    const database = await openCache(path)
    database.exec("UPDATE tasks SET kind = 'gossip'")
    database.close()

    await expect(store.get("t1")).rejects.toThrow('the store holds a task with an unknown kind "gossip"')
    await store.close()
  })

  it("refuses to update a task it does not have", async () => {
    const store = await openTasks(fresh())

    await expect(
      store.update({ ...question, id: "nope", state: "done", createdAt: at("2026-10-05T10:00:00Z") }),
    ).rejects.toMatchObject({ code: "not_found" })
    await store.close()
  })
})
