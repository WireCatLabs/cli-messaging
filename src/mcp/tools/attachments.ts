import * as v from "valibot"
import { MAX_TEXT_CHARS } from "../../attachments/extract.js"
import type { Messenger } from "../../cli/messenger/context.js"
import { servicesFor, storedDeps } from "../../services/index.js"
import { type AnyTool, chatOf, paging, READ, tool } from "../tool.js"

const ITEM = "{ locator, attachment, kind, name, localPath, text: { origin, extractor, chars, error } | null }"

export const attachmentsTools = (messenger: Messenger): Record<string, AnyTool> => {
  const command = messenger.app.command
  return {
    attachments_list: tool({
      title: "List files of stored messages",
      description:
        "Files of this account's stored messages, newest first: where each was saved on this machine and whether " +
        "its text is held — never the text. With `needs_text`, only files saved here that nobody has text for yet, " +
        "such as a scan or a photo: read the file at `localPath` yourself, then write the text with " +
        `attachments_text_set, and content:<word> in messages_search finds it. \`${command} attachments extract\` ` +
        `reads text layers (plain text, Word, PDF). Returns { items: [${ITEM}], page, limit, hasMore }.`,
      input: v.object({
        chat: v.optional(chatOf(messenger)),
        needs_text: v.optional(v.pipe(v.boolean(), v.description("only files still without text"))),
        limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(500))),
        page: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
      }),
      annotations: { ...READ, openWorldHint: false },
      stored: async (store, account, args, defaults) => {
        const { size, number } = paging(args, defaults)
        const found = await servicesFor(storedDeps(messenger, store, account, defaults.guard)).attachments.list({
          ...(args.chat === undefined ? {} : { chat: args.chat }),
          ...(args.needs_text ? { needsText: true } : {}),
          limit: size,
          page: number,
        })
        return { items: found.slice(0, size), page: number, limit: size, hasMore: found.length > size }
      },
    }),

    attachments_text_set: tool({
      title: "Keep the text read from a file",
      description:
        "Keeps text you read from one file of a stored message — a scan, a photo, a PDF of pictures — in the local " +
        "store, replacing what was there, so content:<word> in messages_search finds the message. Nothing is sent. " +
        "`message` is an id in `chat`, or a msg: locator alone; `attachment` (from 1) is needed when the message " +
        "has more than one file. Returns { locator, attachment, origin, chars, replaced }.",
      input: v.object({
        chat: v.optional(chatOf(messenger)),
        message: v.pipe(v.string(), v.minLength(1), v.description("a message id in `chat`, or a msg: locator alone")),
        attachment: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.description("which file, from 1"))),
        text: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_TEXT_CHARS), v.description("the text of the file")),
      }),
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false, destructiveHint: false },
      stored: async (store, account, args, defaults) => {
        const located = args.chat === undefined
        return servicesFor(storedDeps(messenger, store, account, defaults.guard)).attachments.setText({
          chat: located ? args.message : (args.chat as string),
          ...(located ? {} : { message: args.message }),
          ...(args.attachment === undefined ? {} : { attachment: args.attachment }),
          text: args.text,
        })
      },
    }),
  }
}
