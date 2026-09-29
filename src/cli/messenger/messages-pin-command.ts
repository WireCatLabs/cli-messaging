import { annotate } from "@leemour/cli-core/commands"
import { Command } from "commander"
import type { Id } from "../../domain/models.js"
import type { SendGuard } from "../../sends/guard.js"
import { guardedWrite } from "../../sends/guarded.js"
import { type Messenger, messengerContext } from "./context.js"
import { capability, type MessengerAdapter } from "./port.js"

export interface Pinned {
  chatId: Id
  messageId: Id
  pinned: boolean
}

export const pinCommand = (messenger: Messenger): Command =>
  annotate(new Command("pin"), { mutates: true })
    .description("pin a message in a chat, quietly unless --notify")
    .argument("<chat>", messenger.chatArgument)
    .argument("<message>", "the message id")
    .option("--notify", "tell the chat's members about the pin")
    .action(async function (this: Command, chat: string, message: string) {
      const context = messengerContext(this, messenger)
      const { notify } = this.opts<{ notify?: boolean }>()
      context.renderer.result(
        await context.withMessenger((connection) =>
          guardedPin(context.guard, connection, {
            chat,
            message: message.trim(),
            pinned: true,
            notify: notify === true,
          }),
        ),
      )
    })

export const unpinCommand = (messenger: Messenger): Command =>
  annotate(new Command("unpin"), { mutates: true })
    .description("unpin a message in a chat")
    .argument("<chat>", messenger.chatArgument)
    .argument("<message>", "the message id")
    .action(async function (this: Command, chat: string, message: string) {
      const context = messengerContext(this, messenger)
      context.renderer.result(
        await context.withMessenger((connection) =>
          guardedPin(context.guard, connection, { chat, message: message.trim(), pinned: false, notify: false }),
        ),
      )
    })

/** One path for `messages pin|unpin` and their MCP tools. A pin counts toward the hourly limit only when it notifies. */
export const guardedPin = async (
  guard: SendGuard,
  connection: MessengerAdapter,
  { chat, message, pinned, notify }: { chat: string; message: string; pinned: boolean; notify: boolean },
): Promise<Pinned> => {
  const act = pinned
    ? capability(connection, "pin", "pin a message")
    : capability(connection, "unpin", "unpin a message")
  const { id: chatId } = await connection.resolve(chat)
  await guardedWrite(guard, { chatId, kind: "pin", messageId: message, notify }, () => act(chatId, message, { notify }))
  return { chatId, messageId: message, pinned }
}
