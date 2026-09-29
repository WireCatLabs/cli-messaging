import { CliError } from "@leemour/cli-core"
import { annotate } from "@leemour/cli-core/commands"
import { Command } from "commander"
import type { Id } from "../../domain/models.js"
import type { SendGuard } from "../../sends/guard.js"
import { guardedWrite } from "../../sends/guarded.js"
import { type Messenger, messengerContext } from "./context.js"
import { capability, type MessengerAdapter } from "./port.js"

export interface Reacted {
  chatId: Id
  messageId: Id
  /** `null` once it is taken off. */
  reaction: string | null
}

/** `reactions add|remove`: the owner's own reaction on a message. */
export const reactionsCommand = (messenger: Messenger): Command => {
  const reactions = new Command("reactions").description("react to messages")

  annotate(reactions.command("add"), { mutates: true })
    .description("put your reaction on a message; it replaces the one you had")
    .argument("<chat>", messenger.chatArgument)
    .argument("<message>", "the message id")
    .argument("<emoji>", "one emoji, for example 👍")
    .action(async function (this: Command, chat: string, message: string, emoji: string) {
      const context = messengerContext(this, messenger)
      context.renderer.result(
        await context.withMessenger((connection) =>
          guardedReaction(context.guard, connection, { chat, message: message.trim(), emoji: emoji.trim() }),
        ),
      )
    })

  annotate(reactions.command("remove"), { mutates: true })
    .description("take your reaction off a message")
    .argument("<chat>", messenger.chatArgument)
    .argument("<message>", "the message id")
    .action(async function (this: Command, chat: string, message: string) {
      const context = messengerContext(this, messenger)
      context.renderer.result(
        await context.withMessenger((connection) =>
          guardedReaction(context.guard, connection, { chat, message: message.trim(), emoji: null }),
        ),
      )
    })

  return reactions
}

/** One path for `reactions add|remove` and their MCP tools. A reaction never counts toward the hourly limit. */
export const guardedReaction = async (
  guard: SendGuard,
  connection: MessengerAdapter,
  { chat, message, emoji }: { chat: string; message: string; emoji: string | null },
): Promise<Reacted> => {
  if (emoji === "") throw new CliError("validation_error", "which emoji? give one, for example 👍")
  const react = capability(connection, "react", "react to a message")
  const { id: chatId } = await connection.resolve(chat)
  await guardedWrite(guard, { chatId, kind: "reaction", messageId: message }, () => react(chatId, message, emoji))
  return { chatId, messageId: message, reaction: emoji }
}
