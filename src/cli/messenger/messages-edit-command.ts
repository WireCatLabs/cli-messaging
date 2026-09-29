import { CliError } from "@leemour/cli-core"
import { annotate } from "@leemour/cli-core/commands"
import { Command } from "commander"
import type { Message } from "../../domain/models.js"
import type { SendGuard } from "../../sends/guard.js"
import { guardedWrite } from "../../sends/guarded.js"
import { type Messenger, messengerContext } from "./context.js"
import { capability, type MessengerAdapter } from "./port.js"
import { readAll } from "./stdin.js"

export const editCommand = (messenger: Messenger): Command =>
  annotate(new Command("edit"), { mutates: true })
    .description("change the text of your own message; the other side may have read it already")
    .argument("<chat>", messenger.chatArgument)
    .argument("<message>", "the id of your own message")
    .argument("[text]", "the new text; without it, read from stdin")
    .action(async function (this: Command, chat: string, message: string, text: string | undefined) {
      const context = messengerContext(this, messenger)
      const body = text ?? (await readAll(context.stdin))
      if (body.trim() === "") throw new CliError("validation_error", "no new text — give it or pipe it in")
      const edited = await context.withMessenger((connection) =>
        guardedEdit(context.guard, connection, { chat, message: message.trim(), text: body }),
      )
      context.renderer.result({ message: edited })
    })

/** One path for `messages edit` and the MCP edit tool. */
export const guardedEdit = async (
  guard: SendGuard,
  connection: MessengerAdapter,
  { chat, message, text }: { chat: string; message: string; text: string },
): Promise<Message> => {
  const edit = capability(connection, "edit", "edit a message")
  const { id: chatId } = await connection.resolve(chat)
  return guardedWrite(guard, { chatId, kind: "edit", messageId: message, length: text.length }, () =>
    edit(chatId, message, text),
  )
}
