import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import { listed } from "../../cli/paging.js"
import { TAG_TYPES } from "../../domain/tags.js"
import { servicesFor, storedDeps } from "../../services/index.js"
import { type AnyTool, chatOf, READ, tool } from "../tool.js"

const LOCAL = { readOnlyHint: false, idempotentHint: true, openWorldHint: false }
const TARGET =
  "One target: `chat` alone, `contact` (id, @username or name), or `message` with `chat` — or `message` as a " +
  "msg: locator alone. Writes only to the local store; nothing is sent."

export const tagsTools = (messenger: Messenger): Record<string, AnyTool> => {
  const input = v.object({
    tags: v.pipe(
      v.array(v.pipe(v.string(), v.maxLength(64))),
      v.minLength(1),
      v.maxLength(32),
      v.description("tags: 1–32 letters a–z, digits and hyphens; upper case is lowered"),
    ),
    chat: v.optional(chatOf(messenger)),
    contact: v.optional(v.pipe(v.string(), v.minLength(1), v.description("a person: id, @username or name"))),
    message: v.optional(
      v.pipe(v.string(), v.minLength(1), v.description("a message id in `chat`, or a msg: locator alone")),
    ),
  })
  const targetOf = (args: v.InferOutput<typeof input>) => ({
    ...(args.chat === undefined ? {} : { chat: args.chat }),
    ...(args.contact === undefined ? {} : { contact: args.contact }),
    ...(args.message === undefined ? {} : { message: args.message }),
  })
  return {
    tags_list: tool({
      title: "List tags",
      description:
        "The owner's own tags in the local store: this account's tagged chats and messages, and the people of its " +
        "messenger. `tag:<tag>` in messages_search finds the messages they label. Returns { items: [{ tag, type, " +
        "chatId?, chatTitle?, personId?, name?, messageId?, locator?, createdAt }], page, limit, hasMore }.",
      input: v.object({
        tag: v.optional(v.pipe(v.string(), v.minLength(1), v.description("only this tag"))),
        type: v.optional(v.picklist(TAG_TYPES)),
        source: v.optional(v.picklist(["manual", "auto"])),
      }),
      annotations: { ...READ, openWorldHint: false },
      stored: async (store, account, args, defaults) =>
        listed(await servicesFor(storedDeps(messenger, store, account, defaults.guard)).tags.list(args)),
    }),

    tags_add: tool({
      title: "Tag a chat, person or message",
      description: `Puts tags on one chat, person or message. ${TARGET} Returns { target, added, unchanged }.`,
      input,
      annotations: { ...LOCAL, destructiveHint: false },
      stored: async (store, account, args, defaults) => {
        return servicesFor(storedDeps(messenger, store, account, defaults.guard)).tags.add(targetOf(args), args.tags)
      },
    }),

    tags_remove: tool({
      title: "Untag a chat, person or message",
      description: `Takes tags off one chat, person or message. ${TARGET} Returns { target, removed, unchanged }.`,
      input: v.object({ ...input.entries, source: v.optional(v.picklist(["manual", "auto"])) }),
      annotations: { ...LOCAL, destructiveHint: true },
      stored: async (store, account, args, defaults) => {
        return servicesFor(storedDeps(messenger, store, account, defaults.guard)).tags.remove(
          targetOf(args),
          args.tags,
          args.source,
        )
      },
    }),
  }
}
