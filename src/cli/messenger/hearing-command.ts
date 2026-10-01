import { CliError } from "@leemour/cli-core"
import type { Message } from "../../domain/models.js"
import { type Hearing, hearVoices, isVoice, openKept, spoken, withTranscript } from "../../speech/hearing.js"
import { choose } from "../../speech/transcribe.js"
import type { Messenger, MessengerContext } from "./context.js"

export const TRANSCRIBE_OPTION = [
  "--transcribe",
  "turn voice messages not heard yet into text — by the messenger, or a model on this machine; can take minutes",
] as const

export const MODEL_OPTION = [
  "--model <id>",
  "which downloaded speech model hears them, with --transcribe; `models audio list` shows them",
] as const

/** `--model` chooses who hears what `--transcribe` asks for; alone it would quietly do nothing. */
export const modelWith = (transcribe: boolean | undefined, model: string | undefined): string | undefined => {
  if (model !== undefined && transcribe !== true) {
    throw new CliError("validation_error", "--model picks who hears voice messages with --transcribe; add --transcribe")
  }
  return model
}

/**
 * Kept transcripts on every read; new ones with `--transcribe`, over a connection of their own once
 * the messages are read. `undefined` when there is no voice message, and then no file is opened.
 */
export const hearForCommand = async (
  context: MessengerContext,
  messenger: Messenger,
  messages: readonly Message[],
  transcribe: boolean,
  model?: string,
): Promise<Hearing | undefined> => {
  if (!messages.some(isVoice)) return undefined
  const offline = context.settings.offline
  if (transcribe && offline) context.renderer.note("--offline: only voice messages heard before show their text")
  const kept = await openKept(messenger, context.profile, context.env)
  try {
    const hearing = await hearVoices(
      messenger,
      messages,
      kept,
      transcribe && !offline
        ? {
            choice: choose(messenger, context.settings, model === undefined ? {} : { model }, context.env),
            connect: (work) => context.withMessenger(work),
          }
        : undefined,
    )
    if (transcribe && hearing.problem) context.renderer.note(`not transcribed: ${hearing.problem}`)
    else if (transcribe && hearing.unheard.length > 0) {
      context.renderer.note(`${hearing.unheard.length} voice message(s) not heard yet — ask again later`)
    }
    return hearing
  } finally {
    await kept.close()
  }
}

export { heard as heardItems } from "../../speech/hearing.js"

/** The messages as a person reads them: the transcript under the text. */
export const spokenItems = <T extends Message>(messages: readonly T[], hearing: Hearing | undefined): T[] =>
  hearing ? messages.map((message) => spoken(withTranscript(message, hearing)) as T) : [...messages]

/** What the envelope adds when `--transcribe` was asked for. */
export const hearingFields = (hearing: Hearing | undefined, transcribe: boolean) =>
  transcribe ? { unheard: hearing?.unheard ?? [] } : {}
