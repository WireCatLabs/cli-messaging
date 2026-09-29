import type { Command } from "commander"
import { type Messenger, messengerContext } from "./context.js"
import { capability } from "./port.js"

/** `messages transcribe`: a voice message as text, by the messenger's own speech recognition. */
export const transcribeSubcommand = (messages: Command, messenger: Messenger): Command =>
  messages
    .command("transcribe")
    .description(`a voice message as text, transcribed by ${messenger.name ?? messenger.app.command}`)
    .argument("<chat>", messenger.chatArgument)
    .argument("<message>", "the id of a voice message")
    .action(async function (this: Command, chat: string, messageId: string) {
      const context = messengerContext(this, messenger)
      const id = messageId.trim()
      const transcript = await context.withMessenger((connection) =>
        capability(connection, "transcribe", "transcribe voice messages")(chat, id),
      )
      if (transcript.pending) context.renderer.note("the transcription was not finished yet — ask again later")
      if (context.format === "pretty") context.streams.data(`${transcript.text}\n`)
      else context.renderer.result({ messageId: id, ...transcript })
    })
