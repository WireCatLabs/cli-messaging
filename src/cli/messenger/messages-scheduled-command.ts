import { Command } from "commander"
import { renderMessages } from "../../render/messages.js"
import { listed } from "../paging.js"
import { type Messenger, messengerContext } from "./context.js"
import { capability } from "./port.js"

/** Where to look after a scheduled send ended without an answer: repeating it would schedule a second one. */
export const scheduledCommand = (messenger: Messenger): Command =>
  new Command("scheduled")
    .description("messages waiting to be sent later in a chat, soonest first; cancel one in the app")
    .argument("<chat>", messenger.chatArgument)
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      const items = await context.withMessenger((connection) =>
        capability(connection, "scheduled", "list scheduled messages")(chat),
      )
      if (context.format === "pretty") {
        if (items.length === 0) context.renderer.note("nothing scheduled")
        else
          context.streams.data(
            renderMessages(
              items.map((one) => ({ ...one, timestamp: one.scheduledFor ?? one.timestamp })),
              {
                color: context.color,
                verbosity: context.settings.detail,
                senderColors: context.settings.senderColors,
                profile: context.profile,
                provider: messenger.provider,
                locale: messenger.app.locale,
              },
            ),
          )
        return
      }
      if (context.format === "jsonl") context.renderer.stream(items)
      else context.renderer.result(listed(items))
    })
