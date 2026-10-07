import { CliError } from "@leemour/cli-core"
import { capability, type MessengerAdapter } from "../cli/messenger/port.js"
import type { Folder, Id } from "../domain/models.js"
import { guardedWrite, type Operated } from "../sends/guarded.js"
import { newOperationId } from "../sends/send-id.js"
import type { ServiceDeps } from "./deps.js"

export interface FolderEdit {
  title?: string
  /** Chats as typed. */
  add?: string[]
  remove?: string[]
}

/** The owner's chat folders. Nobody else sees them, but they change the owner's own app, so each change is guarded. */
export interface FoldersService {
  list(): Promise<Folder[]>
  create(title: string, chats: string[]): Promise<Operated<{ folder: Folder }>>
  /** `folder` is its id, or its title exactly. */
  update(folder: string, edit: FolderEdit): Promise<Operated<{ folder: Folder }>>
  delete(folder: string): Promise<Operated<{ folderId: string }>>
  /** The folders named go first, in this order; the others keep theirs after them. */
  order(folders: string[]): Promise<Operated<{ folders: Folder[] }>>
  /** A folder shared by a link: every chat in it is joined. */
  join(link: string): Promise<Operated<{ folder: Folder }>>
}

export const foldersService = (deps: ServiceDeps): FoldersService => {
  const online = async (command: string) => {
    if (deps.offline) throw new CliError("validation_error", `\`${command}\` asks the messenger; not with --offline`)
    return deps.connection()
  }
  const ids = async (connection: MessengerAdapter, chats: string[] = []): Promise<Id[]> => {
    const found: Id[] = []
    for (const chat of chats) found.push((await connection.resolve(chat)).id)
    return found
  }
  const folderOf = async (connection: MessengerAdapter, typed: string): Promise<Folder> => {
    const all = await capability(connection, "folders", "list its folders")()
    const found = all.find((one) => one.id === typed) ?? all.filter((one) => one.title === typed)
    if (!Array.isArray(found)) return found
    if (found.length === 1) return found[0] as Folder
    throw new CliError(
      found.length === 0 ? "not_found" : "validation_error",
      found.length === 0
        ? `no folder "${typed}" — \`chats folders list\` shows them`
        : `${found.length} folders are called "${typed}" — name one by its id`,
    )
  }
  return {
    list: async () => capability(await online("chats folders list"), "folders", "list its folders")(),

    create: async (title, chats) => {
      if (title.trim() === "") throw new CliError("validation_error", "a folder needs a name")
      const connection = await online("chats folders create")
      const create = capability(connection, "createFolder", "create a folder")
      const chatIds = await ids(connection, chats)
      const operationId = newOperationId()
      const folder = await guardedWrite(
        deps.guard,
        { operationId, chatId: null, kind: "account", action: "folder-create" },
        () => create(title.trim(), chatIds),
      )
      return { operationId, folder }
    },

    update: async (folder, edit) => {
      if (edit.title === undefined && !edit.add?.length && !edit.remove?.length) {
        throw new CliError("validation_error", "nothing to change — give --title, --add or --remove")
      }
      const connection = await online("chats folders update")
      const update = capability(connection, "updateFolder", "change a folder")
      const { id } = await folderOf(connection, folder)
      const change = {
        ...(edit.title === undefined ? {} : { title: edit.title }),
        ...(edit.add?.length ? { add: await ids(connection, edit.add) } : {}),
        ...(edit.remove?.length ? { remove: await ids(connection, edit.remove) } : {}),
      }
      const operationId = newOperationId()
      const changed = await guardedWrite(
        deps.guard,
        { operationId, chatId: null, kind: "account", action: "folder-update" },
        () => update(id, change),
      )
      return { operationId, folder: changed }
    },

    delete: async (folder) => {
      const connection = await online("chats folders delete")
      const remove = capability(connection, "deleteFolder", "delete a folder")
      const { id } = await folderOf(connection, folder)
      const operationId = newOperationId()
      await guardedWrite(deps.guard, { operationId, chatId: null, kind: "account", action: "folder-delete" }, () =>
        remove(id),
      )
      return { operationId, folderId: id }
    },

    order: async (typed) => {
      if (typed.length === 0) throw new CliError("validation_error", "name the folders in the order you want them")
      const connection = await online("chats folders order")
      const reorder = capability(connection, "orderFolders", "order folders")
      const named: Folder[] = []
      for (const one of typed) {
        const folder = await folderOf(connection, one)
        if (named.some((seen) => seen.id === folder.id))
          throw new CliError("validation_error", `"${one}" is named twice`)
        named.push(folder)
      }
      const all = await capability(connection, "folders", "list its folders")()
      const folders = [...named, ...all.filter((one) => !named.some((seen) => seen.id === one.id))]
      const operationId = newOperationId()
      await guardedWrite(deps.guard, { operationId, chatId: null, kind: "account", action: "folder-order" }, () =>
        reorder(folders.map((one) => one.id)),
      )
      return { operationId, folders }
    },

    join: async (link) => {
      if (link.trim() === "") throw new CliError("validation_error", "give the folder's link")
      const connection = await online("chats folders join")
      const join = capability(connection, "joinFolder", "join a shared folder")
      const operationId = newOperationId()
      const folder = await guardedWrite(
        deps.guard,
        { operationId, chatId: null, kind: "account", action: "folder-join" },
        () => join(link.trim()),
      )
      return { operationId, folder }
    },
  }
}
