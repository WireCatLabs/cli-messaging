import { annotate } from "@leemour/cli-core/commands"
import { Command } from "commander"
import type { Message } from "../../domain/models.js"
import type { SendGuard } from "../../sends/guard.js"
import { guardedWrite } from "../../sends/guarded.js"
import { type Messenger, messengerContext } from "./context.js"
import { capability, type MessengerAdapter } from "./port.js"

export const forwardCommand = (messenger: Messenger): Command =>
  annotate(new Command("forward"), { mutates: true })
    .description("forward one message to another chat")
    .argument("<chat>", `the chat the message is in: ${messenger.chatArgument}`)
    .argument("<message>", "the message id")
    .requiredOption("--to <chat>", `where it goes: ${messenger.chatArgument}`)
    .option("--silent", "deliver it without a notification")
    .action(async function (this: Command, chat: string, message: string) {
      const context = messengerContext(this, messenger)
      const { to, silent } = this.opts<{ to: string; silent?: boolean }>()
      const forwarded = await context.withMessenger((connection) =>
        guardedForward(context.guard, connection, { chat, message: message.trim(), to, silent: silent === true }),
      )
      context.renderer.result({ message: forwarded })
    })

/** Guarded against the chat it goes to: that is where somebody new reads it. */
export const guardedForward = async (
  guard: SendGuard,
  connection: MessengerAdapter,
  { chat, message, to, silent }: { chat: string; message: string; to: string; silent: boolean },
): Promise<Message> => {
  const forward = capability(connection, "forward", "forward a message")
  const { id: fromChatId } = await connection.resolve(chat)
  const { id: toChatId } = await connection.resolve(to)
  return guardedWrite(
    guard,
    { chatId: toChatId, kind: "forward" },
    () => forward(fromChatId, message, toChatId, silent ? { silent } : {}),
    (done) => ({ messageId: done.id }),
  )
}
