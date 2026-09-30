import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import type { MessengerAdapter } from "../../cli/messenger/port.js"
import type { SendGuard } from "../../sends/guard.js"
import { messagesService, onlineDeps } from "../../services/index.js"
import { type AnyTool, APPROVE, chatOf, message, tool, WRITE } from "../tool.js"

/** Offered with `--allow-send`, under the `reaction` permission. */
export const reactionTools = (messenger: Messenger): Record<string, AnyTool> => {
  const chat = chatOf(messenger)
  const messages = (adapter: MessengerAdapter, guard: SendGuard) =>
    messagesService(onlineDeps(messenger, adapter, guard))
  return {
    reactions_add: tool({
      title: "React to a message",
      description:
        "Put the owner's reaction on one message; it replaces the one there was. The sender sees it. " +
        "Only when the owner asked for this reaction on this message.",
      input: v.object({
        chat,
        message,
        emoji: v.pipe(v.string(), v.minLength(1), v.description("one emoji, for example 👍")),
      }),
      annotations: WRITE,
      _meta: APPROVE,
      permission: "reaction",
      online: (adapter, args, { guard }) =>
        messages(adapter, guard).react({ chat: args.chat, message: args.message, emoji: args.emoji }),
    }),
    reactions_remove: tool({
      title: "Take a reaction off",
      description: "Take the owner's reaction off one message. Only when the owner asked for it.",
      input: v.object({ chat, message }),
      annotations: WRITE,
      _meta: APPROVE,
      permission: "reaction",
      online: (adapter, args, { guard }) =>
        messages(adapter, guard).react({ chat: args.chat, message: args.message, emoji: null }),
    }),
  }
}
