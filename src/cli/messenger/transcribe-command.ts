import type { Command } from "commander"
import { openKept } from "../../speech/hearing.js"
import { isInstalled } from "../../speech/install.js"
import { choose, type Heard, hearLocally, hearOnline, notDownloaded } from "../../speech/transcribe.js"
import { type Messenger, messengerContext } from "./context.js"

/** `messages transcribe`: a voice message as text, by the messenger or by a model on this machine. */
export const transcribeSubcommand = (messages: Command, messenger: Messenger): Command =>
  messages
    .command("transcribe")
    .description(
      `a voice message as text — by ${messenger.name ?? messenger.app.command} where it can, else by a model on this machine`,
    )
    .argument("<chat>", messenger.chatArgument)
    .argument("<message>", "the id of a voice message")
    .option("--local", "use the model on this machine, never the messenger")
    .option("--model <id>", "which downloaded model; implies --local (`models audio list`)")
    .action(async function (this: Command, chat: string, messageId: string) {
      const context = messengerContext(this, messenger)
      const choice = choose(messenger, context.settings, this.opts<{ local?: boolean; model?: string }>(), context.env)
      // Before connecting: a missing model should not cost a login.
      if (choice.with === "local" && !isInstalled(choice.model, choice.directory)) {
        throw notDownloaded(messenger, choice.model)
      }
      const id = messageId.trim()
      const [chatId, online] = await context.withMessenger(async (connection) => {
        const { id: resolved } = await connection.resolve(chat)
        return [resolved, await hearOnline(messenger, connection, resolved, id, choice)] as const
      })
      const heard: Heard = online instanceof Uint8Array ? await hearLocally(online, id, choice) : online
      if (heard.pending) context.renderer.note("the transcription was not finished yet — ask again later")
      else {
        const kept = await openKept(messenger, context.profile, context.env)
        try {
          await kept.keep({ chatId, messageId: id }, heard.text, heard.model ?? heard.via)
        } finally {
          await kept.close()
        }
      }
      if (context.format === "pretty") context.streams.data(`${heard.text}\n`)
      else context.renderer.result(heard)
    })
