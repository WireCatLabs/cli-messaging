import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import type { MessengerAdapter } from "../../cli/messenger/port.js"
import type { SendGuard } from "../../sends/guard.js"
import { onlineDeps, servicesFor } from "../../services/index.js"
import { type AnyTool, APPROVE, chatOf, message, tool, WRITE } from "../tool.js"

/** What changes a message others already have, offered with `--allow-send`, each behind its own `allow` permission. */
export const messageActionTools = (messenger: Messenger): Record<string, AnyTool> => {
  const chat = chatOf(messenger)
  const messages = (adapter: MessengerAdapter, guard: SendGuard) =>
    servicesFor(onlineDeps(messenger, adapter, guard)).messages
  return {
    messages_edit: tool({
      title: "Edit a message",
      description:
        "Replace the text of one of the owner's own messages. Only when the owner asked for this exact change. " +
        "The other side may have read the old text already. Repeating the same edit changes nothing.",
      input: v.object({ chat, message, text: v.pipe(v.string(), v.minLength(1)) }),
      annotations: WRITE,
      _meta: APPROVE,
      permission: "edit",
      online: (adapter, args, { guard }) =>
        messages(adapter, guard).edit({ chat: args.chat, message: args.message, text: args.text }),
    }),
    messages_forward: tool({
      title: "Forward a message",
      description:
        "Forward one message to another chat, where new people will read it. Only when the owner asked for this " +
        "message to go to this chat. On outcome_unknown, look in the target chat before forwarding again: a repeat " +
        "is a second copy.",
      input: v.object({
        chat: v.pipe(v.string(), v.minLength(1), v.description("the chat the message is in")),
        message,
        to: v.pipe(v.string(), v.minLength(1), v.description(`where it goes: ${messenger.chatArgument}`)),
        silent: v.optional(v.pipe(v.boolean(), v.description("deliver without a notification"))),
      }),
      annotations: WRITE,
      _meta: APPROVE,
      permission: "forward",
      online: (adapter, args, { guard }) =>
        messages(adapter, guard).forward({
          chat: args.chat,
          message: args.message,
          to: args.to,
          silent: args.silent === true,
        }),
    }),
    messages_pin: tool({
      title: "Pin a message",
      description:
        "Pin one message in a chat, quietly unless notify is true. Only when the owner asked for this pin. " +
        "In a one-to-one chat the pin is on the owner's side only.",
      input: v.object({
        chat,
        message,
        notify: v.optional(v.pipe(v.boolean(), v.description("tell the chat's members"))),
      }),
      annotations: WRITE,
      _meta: APPROVE,
      permission: "pin",
      online: (adapter, args, { guard }) =>
        messages(adapter, guard).pin({ chat: args.chat, message: args.message, notify: args.notify === true }),
    }),
    messages_unpin: tool({
      title: "Unpin a message",
      description: "Unpin one message in a chat. Only when the owner asked for it.",
      input: v.object({ chat, message }),
      annotations: WRITE,
      _meta: APPROVE,
      permission: "pin",
      online: (adapter, args, { guard }) => messages(adapter, guard).unpin({ chat: args.chat, message: args.message }),
    }),
  }
}
