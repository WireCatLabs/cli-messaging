import type { Messenger } from "../cli/messenger/context.js"
import type { AnyTool } from "./tool.js"
import { accountTools } from "./tools/account.js"
import { chatsTools } from "./tools/chats.js"
import { chatsReadTools } from "./tools/chats-read.js"
import { contactsTools } from "./tools/contacts.js"
import { inboxTools } from "./tools/inbox.js"
import { messagesTools } from "./tools/messages.js"
import { messageActionTools } from "./tools/messages-actions.js"
import { messagesPhotoTools } from "./tools/messages-photo.js"
import { messageSendTools } from "./tools/messages-send.js"
import { messagesTranscribeTools } from "./tools/messages-transcribe.js"
import { reactionTools } from "./tools/reactions.js"
import { reviewTools } from "./tools/review.js"
import { topicsTools } from "./tools/topics.js"

/**
 * The read tools, each answering what its command's `--json` prints. Named `<cli>_<command words>`,
 * so `tg_chats_list` is `tg chats list`. A new resource is a file in `tools/` and a line here.
 */
export const readTools = (messenger: Messenger): Record<string, AnyTool> => ({
  ...inboxTools(messenger),
  ...reviewTools(messenger),
  ...topicsTools(messenger),
  ...accountTools(messenger),
  ...chatsTools(messenger),
  ...contactsTools(messenger),
  ...messagesTools(messenger),
  ...messagesPhotoTools(messenger),
  ...messagesTranscribeTools(messenger),
})

/** Offered only with `--allow-mark-read`, which `--allow-send` does not imply: the other side sees it. */
export const markReadTools = (messenger: Messenger): Record<string, AnyTool> => chatsReadTools(messenger)

/** Offered only with `--allow-send`. */
export const sendTools = (messenger: Messenger): Record<string, AnyTool> => ({
  ...messageSendTools(messenger),
  ...messageActionTools(messenger),
  ...reactionTools(messenger),
})
