import { Command } from "commander"
import type { MessageHit, Review } from "../../domain/models.js"
import { renderMessages } from "../../render/messages.js"
import { CHAT_WINDOW, REVIEW_DAYS, reviewStart, UNANSWERED_HOURS } from "../../services/inbox.js"
import { momentOf } from "../../services/moment.js"
import { modelWith } from "../../speech/hearing.js"
import { parseDuration } from "../settings.js"
import { type Messenger, messengerContext } from "./context.js"
import {
  heardItems,
  hearForCommand,
  hearingFields,
  MODEL_OPTION,
  spokenItems,
  TRANSCRIBE_OPTION,
} from "./hearing-command.js"

/** `--unanswered` with no value is `true`. */
export const unansweredHours = (value: unknown, flag = "--unanswered"): number =>
  value === true ? UNANSWERED_HOURS : parseDuration(String(value), flag) / 3_600_000

/**
 * **Everything said since a point, both sides, in every chat that changed** — the reading half of a
 * review of who owes what (max-cli's `review`). Sorting it is the reader's job, person or agent.
 * Reads only: nothing is marked read, and `inbox --new` keeps its point.
 */
export const reviewCommand = (messenger: Messenger): Command =>
  new Command("review")
    .description("every message, yours too, in chats that changed since a point — for reviewing who owes what")
    .option(
      "--since-time <time>",
      `where the last review ended — ISO 8601, or 2h / 1d ago; ${REVIEW_DAYS} days ago if not given`,
    )
    .option("--chat <chat>", `only this chat: ${messenger.chatArgument}`)
    .option(
      "--unanswered [duration]",
      `only questions to you or a group's admins that nobody answered, asked at least this long ago — 4h, 1d; ${UNANSWERED_HOURS}h if not given`,
    )
    .option("--all", "muted and archived chats too — left out unless they mention you or reply to you")
    .option(...TRANSCRIBE_OPTION)
    .option(...MODEL_OPTION)
    .action(async function (this: Command) {
      const options = this.opts<{
        sinceTime?: string
        chat?: string
        unanswered?: string | true
        all?: boolean
        transcribe?: boolean
        model?: string
      }>()
      const hearWith = modelWith(options.transcribe, options.model)
      const context = messengerContext(this, messenger)
      const { settings, renderer, format, streams } = context
      const since = options.sinceTime === undefined ? reviewStart() : momentOf(options.sinceTime, "--since-time")
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
      ? `from ${found.since} to ${found.until} — the next review starts with --since-time ${found.until}`
      : `from ${found.since} to ${found.until}, incomplete — keep --since-time ${found.since} for the next review`,
  )
}
