import { CliError } from "@leemour/cli-core"
import {
  matches,
  TASK_KINDS,
  TASK_ORIGINS,
  TASK_STATES,
  type Task,
  type TaskFilter,
  type TaskStore,
} from "@leemour/cli-tasks"
import type { CacheDatabase, SqlValue } from "../driver.js"

const COLUMNS =
  "id, source, source_kind, account, group_key, kind, state, reason, origin, created_at, due_at, closed_at, closed_by"

/**
 * Tasks for `@leemour/cli-tasks`, in the message store so backup, restore and export carry them. A task
 * holds a locator, never the message text; kind, state and origin are checked in code, as `chats.kind` is.
 */
export const taskStoreOver = (database: CacheDatabase): TaskStore => {
  const insert = database.prepare(`INSERT INTO tasks (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const update = database.prepare(
    "UPDATE tasks SET state = ?, reason = ?, due_at = ?, closed_at = ?, closed_by = ? WHERE id = ?",
  )
  const get = database.prepare(`SELECT ${COLUMNS} FROM tasks WHERE id = ?`)
  const bySource = database.prepare(`SELECT ${COLUMNS} FROM tasks WHERE account = ? AND source = ? ORDER BY created_at`)

  return {
    get: async (id) => {
      const row = get.get(id)
      return row && toTask(row)
    },
    findBySource: async (account, source) => bySource.all(account, source).map(toTask),
    insert: async (task) => {
      insert.run(...toRow(task))
    },
    update: async (task) => {
      const { changes } = update.run(
        task.state,
        task.reason ?? null,
        time(task.dueAt),
        time(task.closedAt),
        task.closedBy ?? null,
        task.id,
      )
      if (changes === 0) throw new CliError("not_found", `no task ${task.id}`)
    },
    list: async (filter) => listTasks(database, filter),
  }
}

const listTasks = (database: CacheDatabase, filter: TaskFilter): Task[] => {
  const where: string[] = []
  const values: SqlValue[] = []
  const equal = (column: string, value: string | undefined) => {
    if (value === undefined) return
    where.push(`${column} = ?`)
    values.push(value)
  }
  equal("account", filter.account)
  equal("state", filter.state)
  equal("group_key", filter.group)
  equal("kind", filter.kind)
  if (filter.createdBefore) {
    where.push("created_at < ?")
    values.push(filter.createdBefore.getTime())
  }
  const sql = `SELECT ${COLUMNS} FROM tasks${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, id`
  // matches() again: the SQL narrows, the package's own filter stays the definition.
  return database
    .prepare(sql)
    .all(...values)
    .map(toTask)
    .filter((task) => matches(task, filter))
}

const time = (date: Date | undefined): number | null => (date ? date.getTime() : null)

const toRow = (task: Task): SqlValue[] => [
  task.id,
  task.source,
  task.sourceKind,
  task.account,
  task.group,
  task.kind,
  task.state,
  task.reason ?? null,
  task.origin,
  task.createdAt.getTime(),
  time(task.dueAt),
  time(task.closedAt),
  task.closedBy ?? null,
]

const oneOf = <T extends string>(values: readonly T[], value: unknown, column: string): T => {
  if (typeof value === "string" && (values as readonly string[]).includes(value)) return value as T
  throw new CliError("configuration_error", `the store holds a task with an unknown ${column} "${String(value)}"`)
}

const optionalDate = (value: unknown): Date | undefined => (value === null ? undefined : new Date(Number(value)))

const toTask = (row: Record<string, unknown>): Task => {
  const task: Task = {
    id: String(row.id),
    source: String(row.source),
    sourceKind: String(row.source_kind),
    account: String(row.account),
    group: String(row.group_key),
    kind: oneOf(TASK_KINDS, row.kind, "kind"),
    state: oneOf(TASK_STATES, row.state, "state"),
    origin: oneOf(TASK_ORIGINS, row.origin, "origin"),
    createdAt: new Date(Number(row.created_at)),
  }
  const dueAt = optionalDate(row.due_at)
  const closedAt = optionalDate(row.closed_at)
  if (row.reason !== null) task.reason = String(row.reason)
  if (dueAt) task.dueAt = dueAt
  if (closedAt) task.closedAt = closedAt
  if (row.closed_by !== null) task.closedBy = oneOf(TASK_ORIGINS, row.closed_by, "closed_by")
  return task
}
