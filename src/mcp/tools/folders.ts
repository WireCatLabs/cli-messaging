import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import type { MessengerAdapter } from "../../cli/messenger/port.js"
import type { SendGuard } from "../../sends/guard.js"
import { onlineDeps, servicesFor } from "../../services/index.js"
import { type AnyTool, APPROVE, READ, tool, WRITE } from "../tool.js"

const folderRef = v.pipe(v.string(), v.minLength(1), v.description("folder id, or its title exactly"))
const chatList = v.optional(v.array(v.pipe(v.string(), v.minLength(1))))

/** The owner's chat folders: only the owner sees them, but each change is the owner's app changing. */
export const folderTools = (messenger: Messenger): Record<string, AnyTool> => {
  const folders = (adapter: MessengerAdapter, guard: SendGuard) =>
    servicesFor(onlineDeps(messenger, adapter, guard)).folders
  return {
    chats_folders_list: tool({
      title: "Chat folders",
      description: "The owner's chat folders, in the order the app shows them, with the chats added to each.",
      input: v.object({}),
      annotations: READ,
      online: (adapter, _args, { guard }) => folders(adapter, guard).list(),
    }),
    chats_folders_create: tool({
      title: "Create a chat folder",
      description: "Create a chat folder with these chats in it. Only when the owner asked.",
      input: v.object({ title: v.pipe(v.string(), v.minLength(1)), chats: chatList }),
      annotations: WRITE,
      _meta: APPROVE,
      permission: "folders",
      online: (adapter, args, { guard }) => folders(adapter, guard).create(args.title, args.chats ?? []),
    }),
    chats_folders_update: tool({
      title: "Change a chat folder",
      description: "Rename a chat folder, or add chats to it or take them out. Only when the owner asked.",
      input: v.object({
        folder: folderRef,
        title: v.optional(v.pipe(v.string(), v.minLength(1))),
        add: chatList,
        remove: chatList,
      }),
      annotations: WRITE,
      _meta: APPROVE,
      permission: "folders",
      online: (adapter, args, { guard }) =>
        folders(adapter, guard).update(args.folder, {
          ...(args.title === undefined ? {} : { title: args.title }),
          ...(args.add ? { add: args.add } : {}),
          ...(args.remove ? { remove: args.remove } : {}),
        }),
    }),
    chats_folders_delete: tool({
      title: "Delete a chat folder",
      description: "Delete a chat folder; the chats in it stay. Only when the owner asked.",
      input: v.object({ folder: folderRef }),
      annotations: WRITE,
      _meta: APPROVE,
      permission: "folders",
      online: (adapter, args, { guard }) => folders(adapter, guard).delete(args.folder),
    }),
  }
}
