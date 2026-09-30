import { CliError } from "@leemour/cli-core"
import { annotate } from "@leemour/cli-core/commands"
import { Command } from "commander"
import { type Messenger, messengerContext } from "./context.js"
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
      context.renderer.result(
        await context.withServices((services) => services.messages.edit({ chat, message: message.trim(), text: body })),
      )
    })
