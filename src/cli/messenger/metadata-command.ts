import { CliError } from "@leemour/cli-core"
import { Command } from "commander"
import { positiveCount } from "../paging.js"
import { type Messenger, messengerContext, refuseLocalWrite } from "./context.js"

export const metadataCommand = (messenger: Messenger): Command => {
  const command = new Command("metadata").description("cached group/channel descriptions for local automatic tags")
  command
    .command("get")
    .requiredOption("--chat <chat>", "a stored chat")
    .action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      const { chat } = this.opts<{ chat: string }>()
      context.renderer.result(await context.withServices((services) => services.metadata.get(chat)))
    })
  command
    .command("refresh")
    .requiredOption(
      "--chat <chat>",
      "stored group/channel; repeat for several",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option("--limit <number>", "process at most 1–500 chats", positiveCount("--limit"), 50)
    .action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, "metadata.refresh")
      const options = this.opts<{ chat: string[]; limit: number }>()
      const limit = Number(options.limit)
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
        throw new CliError("validation_error", "--limit takes 1–500")
      const items = []
      for (const chat of options.chat.slice(0, limit)) {
        try {
          items.push(await context.withServices((services) => services.metadata.refresh(chat)))
        } catch (error) {
          if (!(error instanceof CliError)) throw error
          items.push({ chatId: chat, error: { code: error.code, message: error.message } })
        }
      }
      context.renderer.result({ items, hasMore: options.chat.length > limit })
    })
  return command
}
