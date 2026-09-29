import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import { capability } from "../../cli/messenger/port.js"
import { type AnyTool, chatOf, message, nameOf, READ, tool } from "../tool.js"

export const messagesTranscribeTools = (messenger: Messenger): Record<string, AnyTool> => ({
  messages_transcribe: tool({
    title: "Read a voice message",
    description:
      `A voice or video note as text, transcribed by ${nameOf(messenger)}. Can take up to a minute; ` +
      "pending: true means it was not finished yet — ask again later. Returns { messageId, text, pending }.",
    input: v.object({ chat: chatOf(messenger), message }),
    annotations: READ,
    online: async (adapter, args) => ({
      messageId: args.message,
      ...(await capability(adapter, "transcribe", "transcribe voice messages")(args.chat, args.message)),
    }),
  }),
})
