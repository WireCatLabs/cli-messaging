import { annotate } from "@leemour/cli-core/commands"
import { Command } from "commander"
import { type Messenger, messengerContext } from "./context.js"

export const forwardCommand = (messenger: Messenger): Command =>
  annotate(new Command("forward"), { mutates: true })
    .description("forward one message to another chat")
    .argument("<chat>", `the chat the message is in: ${messenger.chatArgument}`)
    .argument("<message>", "the message id")
    .requiredOption("--to <chat>", `where it goes: ${messenger.chatArgument}`)
    .option("--silent", "deliver it without a notification")
    .option("--send-id <id>", "repeat a forward whose outcome was unknown, without risking a second copy")
    .action(async function (this: Command, chat: string, message: string) {
      const context = messengerContext(this, messenger)
      const { to, silent, sendId } = this.opts<{ to: string; silent?: boolean; sendId?: string }>()
      context.renderer.result(
        await context.withServices((services) =>
          services.messages.forward({
            chat,
            message: message.trim(),
            to,
            silent: silent === true,
            ...(sendId === undefined ? {} : { sendId }),
          }),
        ),
      )
    })
