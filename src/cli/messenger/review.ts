import { CliError } from "@leemour/cli-core"
import { Command } from "commander"
import type { MessageHit, Review } from "../../domain/models.js"
import { renderMessages } from "../../render/messages.js"
import { CHAT_WINDOW } from "../../services/inbox.js"
import { type Messenger, messengerContext } from "./context.js"
import {
  heardItems,
  hearForCommand,
  hearingFields,
  MODEL_OPTION,
  modelWith,
  spokenItems,
  TRANSCRIBE_OPTION,
} from "./hearing-command.js"
import { momentOf } from "./inbox.js"

/** Owner's ruling in max-cli: without a boundary, a review looks at the last three days. */
export const REVIEW_DAYS = 3
export const UNANSWERED_HOURS = 24
export const reviewStart = (now = Date.now()): number => now - REVIEW_DAYS * 86_400_000

/** `--unanswered` with no value is `true`; a value is hours, a fraction allowed. */
export const unansweredHours = (value: unknown, flag = "--unanswered"): number => {
  if (value === true) return UNANSWERED_HOURS
  const hours = Number(value)
  if (!Number.isFinite(hours) || hours < 0) {
    throw new CliError("validation_error", `${flag} takes hours, a number 0 or more — got ${String(value)}`)
  }
  return hours
}

/**
 * **Everything said since a point, both sides, in every chat that changed** — the reading half of a
 * review of who owes what (max-cli's `review`). Sorting it is the reader's job, person or agent.
 * Reads only: nothing is marked read, and `inbox --new` keeps its point.
 */
export const reviewCommand = (messenger: Messenger): Command =>
  new Command("review")
    .description("every message, yours too, in chats that changed since a point — for reviewing who owes what")
    .option(
      "--since <time>",
      `where the last review ended — ISO 8601, or 2h / 1d ago; ${REVIEW_DAYS} days ago if not given`,
    )
    .option("--chat <chat>", `only this chat: ${messenger.chatArgument}`)
    .option(
      "--unanswered [hours]",
      `only questions to you or a group's admins that nobody answered, asked at least this long ago; ${UNANSWERED_HOURS} hours if not given`,
    )
    .option("--all", "muted and archived chats too — left out unless they mention you or reply to you")
    .option(...TRANSCRIBE_OPTION)
    .option(...MODEL_OPTION)
    .action(async function (this: Command) {
      const options = this.opts<{
        since?: string
        chat?: string
        unanswered?: string | true
        all?: boolean
        transcribe?: boolean
        model?: string
      }>()
      const hearWith = modelWith(options.transcribe, options.model)
      const context = messengerContext(this, messenger)
      const { settings, renderer, format, streams } = context
      const since = options.since === undefined ? reviewStart() : momentOf(options.since)
      const hours = options.unanswered === undefined ? undefined : unansweredHours(options.unanswered)
      const found = await context.withServices((services) =>
        services.inbox.review({
          since,
          ...(options.chat === undefined ? {} : { chat: options.chat }),
          ...(options.all ? { all: true } : {}),
          ...(hours === undefined ? {} : { unansweredAfterHours: hours }),
        }),
      )

      const read: MessageHit[] = found.chats.flatMap((chat) =>
        chat.messages.map((message) => ({ ...message, chatTitle: chat.title })),
      )
      const transcribe = options.transcribe === true
      const hearing = await hearForCommand(context, messenger, read, transcribe, hearWith)
      const messages = heardItems(read, hearing)
      if (format === "jsonl") renderer.stream(messages)
      else if (format !== "pretty") {
        renderer.result({
          ...found,
          chats: found.chats.map((chat) => ({ ...chat, messages: heardItems(chat.messages, hearing) })),
          ...hearingFields(hearing, transcribe),
        })
      } else if (messages.length > 0) {
        streams.data(
          renderMessages(spokenItems(messages, hearing), {
            color: context.color,
            verbosity: settings.detail,
            senderColors: settings.senderColors,
            profile: context.profile,
            provider: messenger.provider,
            locale: messenger.app.locale,
          }),
        )
      }
      notes(found, messenger.app.command, renderer.note.bind(renderer))
    })

const notes = (found: Review, command: string, note: (message: string) => void): void => {
  for (const chat of found.chats) {
    if (chat.more)
      note(`${chat.title ?? chat.id}: cut short, only the newest — \`${command} messages list ${chat.id}\``)
    if (chat.answeredBy === "owner")
      note(`${chat.title ?? chat.id}: its admins are not known, so only your answers count`)
  }
  if (found.skipped.length > 0) {
    note(`not read — too many chats at once: ${found.skipped.map((chat) => chat.title ?? chat.id).join(", ")}`)
  }
  if (found.partial) note(`only the ${CHAT_WINDOW} newest chats were looked at; an older one may have more`)
  if (found.quiet > 0) note(`${found.quiet} muted or archived chats left out — --all reads them`)
  if (found.unanswered) {
    note(
      `questions from ${found.since} to ${found.until} still open after ${found.unanswered.olderThanHours} hours; ` +
        "an answer after the review's end is not seen",
    )
    return
  }
  note(
    found.complete
      ? `from ${found.since} to ${found.until} — the next review starts with --since ${found.until}`
      : `from ${found.since} to ${found.until}, incomplete — keep --since ${found.since} for the next review`,
  )
}
