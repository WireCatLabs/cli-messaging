import { Command } from "commander"
import { type Messenger, messengerContext } from "./context.js"

export const messageLinkCommand = (messenger: Messenger): Command =>
  new Command("link")
    .description("a message permalink when supported, and its account-scoped locator")
    .argument("<chat>", `${messenger.chatArgument}; or a msg: locator, with no message id after it`)
    .argument("[message]", "the message id")
    .action(async function (this: Command, chat: string, message: string | undefined) {
      const context = messengerContext(this, messenger)
      const result = await context.withServices((services) => services.messages.link(chat, message))
      if (context.format === "pretty") {
        context.renderer.result(result.url ?? result.locator)
        context.renderer.note(
          result.url ? `link access: ${result.access}; a link grants no membership` : `no permalink: ${result.reason}`,
        )
      } else context.renderer.result(result)
    })
