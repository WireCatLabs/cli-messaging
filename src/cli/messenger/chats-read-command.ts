import { annotate } from "@leemour/cli-core/commands"
import { Command } from "commander"
import { type Messenger, messengerContext } from "./context.js"

export const markReadCommand = (messenger: Messenger): Command =>
  annotate(new Command("mark-read"), { mutates: true })
    .description("mark a chat read; the other side sees that you read it")
    .argument("<chat>", messenger.chatArgument)
    .option("--until <message>", "only up to this message id; the newest by default")
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      const { until } = this.opts<{ until?: string }>()
      context.renderer.result(
        await context.withServices((services) =>
          services.chats.markRead({ chat, ...(until === undefined ? {} : { until: until.trim() }) }),
        ),
      )
    })
