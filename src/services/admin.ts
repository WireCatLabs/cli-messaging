import { CliError } from "@leemour/cli-core"
import { capability } from "../cli/messenger/port.js"
import type { GroupCard, GroupChange, Id } from "../domain/models.js"
import { guardedWrite, type Operated } from "../sends/guarded.js"
import { newOperationId } from "../sends/send-id.js"
import type { ServiceDeps } from "./deps.js"

export interface NewGroup {
  title: string
  /** As typed: ids, handles or names. */
  people: string[]
  channel: boolean
}

/** Groups the owner makes, joins and leaves — each a write others see, through the guard. */
export interface AdminService {
  create(group: NewGroup): Promise<Operated<{ chat: GroupCard }>>
  join(link: string): Promise<Operated<{ chat: GroupCard }>>
  leave(chat: string): Promise<Operated<{ chatId: Id }>>
  update(chat: string, change: GroupChange): Promise<Operated<{ chat: GroupCard }>>
  /** The invite link, or `not_found` when the owner may not see it. */
  link(chat: string): Promise<{ chatId: Id; title: string | null; link: string }>
  resetLink(chat: string): Promise<Operated<{ chat: GroupCard }>>
}

export const adminService = (deps: ServiceDeps): AdminService => {
  const online = async (command: string) => {
    if (deps.offline) throw new CliError("validation_error", `\`${command}\` changes a chat; not with --offline`)
    return deps.connection()
  }

  return {
    create: async ({ title, people, channel }) => {
      if (title.trim() === "") throw new CliError("validation_error", "a group needs a title")
      const connection = await online("chats create")
      const create = capability(connection, "createGroup", "create a group")
      const personIds = people.length === 0 ? [] : await capability(connection, "people", "find people")(people)
      const operationId = newOperationId()
      const chat = await guardedWrite(
        deps.guard,
        { operationId, chatId: null, kind: "chat", action: "create", personIds, people: personIds.length },
        () => create(title.trim(), personIds, { channel }),
        (made) => ({ chatId: made.id }),
      )
      return { operationId, chat }
    },

    join: async (link) => {
      const connection = await online("chats join")
      const join = capability(connection, "join", "join a chat by its link")
      const operationId = newOperationId()
      const chat = await guardedWrite(
        deps.guard,
        { operationId, chatId: null, kind: "chat", action: "join" },
        () => join(link.trim()),
        (joined) => ({ chatId: joined.id }),
      )
      return { operationId, chat }
    },

    leave: async (chat) => {
      const connection = await online("chats leave")
      const leave = capability(connection, "leave", "leave a chat")
      const { id: chatId } = await connection.resolve(chat)
      const operationId = newOperationId()
      await guardedWrite(deps.guard, { operationId, chatId, kind: "chat", action: "leave" }, () => leave(chatId))
      return { operationId, chatId }
    },

    update: async (chat, change) => {
      const settings = Object.keys(change.settings ?? {}).length
      if (change.title === undefined && change.description === undefined && settings === 0) {
        throw new CliError("validation_error", "nothing to change — give a title, a description or a setting")
      }
      if (change.title !== undefined && change.title.trim() === "") {
        throw new CliError("validation_error", "a group needs a title")
      }
      const connection = await online("chats update")
      const update = capability(connection, "updateGroup", "change a group")
      const { id: chatId } = await connection.resolve(chat)
      const operationId = newOperationId()
      const action = change.title === undefined && change.description === undefined ? "settings" : "update"
      const card = await guardedWrite(deps.guard, { operationId, chatId, kind: "chat", action }, () =>
        update(chatId, change),
      )
      return { operationId, chat: card }
    },

    link: async (chat) => {
      const group = await capability(await online("chats link show"), "group", "read a group")(chat)
      if (group.link === null) {
        throw new CliError(
          "not_found",
          `${group.title ?? group.id} shows you no invite link — only admins, or members when the group allows it`,
        )
      }
      return { chatId: group.id, title: group.title, link: group.link }
    },

    resetLink: async (chat) => {
      const connection = await online("chats link reset")
      const reset = capability(connection, "resetInviteLink", "replace an invite link")
      const { id: chatId } = await connection.resolve(chat)
      const operationId = newOperationId()
      const card = await guardedWrite(deps.guard, { operationId, chatId, kind: "chat", action: "link.reset" }, () =>
        reset(chatId),
      )
      return { operationId, chat: card }
    },
  }
}
