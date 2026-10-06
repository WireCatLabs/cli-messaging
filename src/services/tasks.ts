import { CliError, singleLine } from "@leemour/cli-core"
import {
  type ClosedState,
  createTaskService,
  type GroupStats,
  TASK_KINDS,
  TASK_STATES,
  type Task,
  type TaskKind,
  type TaskOrigin,
  type TaskState,
} from "@leemour/cli-tasks"
import { isLocator, parseLocator } from "../domain/locator.js"
import type { AccountKey, MessageStore } from "../store/store.js"
import type { ServiceDeps } from "./deps.js"
import { storedChatId } from "./messages.js"
import { taskAccount } from "./task-rules.js"

export { TASK_KINDS, TASK_STATES }

/** A task as shown: the message it points at, read from the store, or `null` when the store no longer has it. */
export interface TaskView extends Task {
  message: { senderName: string | null; text: string; timestamp: string } | null
}

export interface TaskListFilter {
  state?: TaskState
  chat?: string
  types?: readonly TaskKind[]
  /** ms: only tasks opened before it. */
  before?: number
  limit?: number
}

/** What waits on the owner, kept in the local store by `@leemour/cli-tasks`; nothing here reaches the messenger. */
export interface TasksService {
  list(filter?: TaskListFilter): Promise<TaskView[]>
  add(message: string, type: TaskKind, origin: TaskOrigin): Promise<{ task: TaskView; created: boolean }>
  close(id: string, options: { as: ClosedState; reason?: string; by: TaskOrigin }): Promise<TaskView>
  stats(filter?: { chat?: string; type?: TaskKind }): Promise<GroupStats[]>
}

export const PREVIEW = 200

const oneOf =
  <T extends string>(values: readonly T[], name: string, flag: string) =>
  (typed: string) => {
    const value = typed.trim().toLowerCase()
    if ((values as readonly string[]).includes(value)) return value as T
    throw new CliError(
      "validation_error",
      `${flag} takes ${values.join(", ")} — not "${singleLine(typed)}" as a ${name}`,
    )
  }

export const taskTypeOf = oneOf(TASK_KINDS, "task type", "--type")
export const taskStateOf = oneOf(TASK_STATES, "task state", "--state")
export const closedStateOf = oneOf(["done", "dismissed"] as const, "way to close a task", "--as")
export const taskTypesOf = (typed: string): TaskKind[] => [
  ...new Set(
    typed
      .split(",")
      .filter((one) => one.trim() !== "")
      .map(taskTypeOf),
  ),
]

export const tasksService = (deps: ServiceDeps): TasksService => {
  const inStore = async <T>(work: (store: MessageStore, account: AccountKey) => Promise<T>): Promise<T> =>
    work(await deps.store(), await deps.account())
  const service = (store: MessageStore) => createTaskService({ store: store.tasks })

  const view = async (store: MessageStore, account: AccountKey, task: Task): Promise<TaskView> => {
    const { chat, message } = parseLocator(task.source)
    const found = await store.message(account, message, { chatId: chat })
    return {
      ...task,
      message: found
        ? { senderName: found.senderName, text: found.text.slice(0, PREVIEW), timestamp: found.timestamp }
        : null,
    }
  }
  const groupOf = async (store: MessageStore, account: AccountKey, chat: string | undefined) =>
    chat === undefined ? undefined : storedChatId(deps.messenger, chat, store, account)

  return {
    list: (filter = {}) =>
      inStore(async (store, account) => {
        const group = await groupOf(store, account, filter.chat)
        const found = await service(store).list({
          account: taskAccount(account),
          ...(filter.state === undefined ? {} : { state: filter.state }),
          ...(group === undefined ? {} : { group }),
          ...(filter.before === undefined ? {} : { createdBefore: new Date(filter.before) }),
        })
        const typed = filter.types?.length ? found.filter((task) => filter.types?.includes(task.kind)) : found
        const shown = filter.limit === undefined ? typed : typed.slice(0, filter.limit)
        return Promise.all(shown.map((task) => view(store, account, task)))
      }),

    add: (message, type, origin) =>
      inStore(async (store, account) => {
        if (!isLocator(message)) {
          throw new CliError(
            "validation_error",
            `"${singleLine(message)}" is not a message locator — give msg:<provider>/<account>/<chat>/<message>, as review --json and messages list --json show`,
          )
        }
        const locator = parseLocator(message)
        if (locator.provider !== account.provider || locator.account !== account.account)
          throw new CliError("validation_error", "that locator belongs to another account; select its profile first")
        const { task, created } = await service(store).add({
          source: message.trim(),
          sourceKind: "message",
          account: taskAccount(account),
          group: locator.chat,
          kind: type,
          origin,
        })
        return { task: await view(store, account, task), created }
      }),

    close: (id, { as, reason, by }) =>
      inStore(async (store, account) => {
        const existing = await store.tasks.get(id)
        if (!existing || existing.account !== taskAccount(account))
          throw new CliError("not_found", `no task ${singleLine(id)} for this account — tasks list shows the ids`)
        try {
          const closed = await service(store).close(id, { as, by, ...(reason === undefined ? {} : { reason }) })
          return view(store, account, closed)
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "closed")
            throw new CliError("validation_error", `${error.message}; a closed task stays closed`)
          throw error
        }
      }),

    stats: (filter = {}) =>
      inStore(async (store, account) => {
        const group = await groupOf(store, account, filter.chat)
        const rows = await service(store).stats({
          account: taskAccount(account),
          ...(filter.type === undefined ? {} : { kind: filter.type }),
        })
        return group === undefined ? rows : rows.filter((one) => one.group === group)
      }),
  }
}
