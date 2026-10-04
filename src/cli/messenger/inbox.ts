import { Command } from "commander"
import type { MessageHit } from "../../domain/models.js"
import { renderMessages } from "../../render/messages.js"
import { CHAT_KINDS } from "../../services/chats.js"
import { kindsOf } from "../../services/inbox.js"
import { momentOf } from "../../services/moment.js"
import { modelWith } from "../../speech/hearing.js"
import { positiveCount } from "../paging.js"
import { MARK_READ_OPTION, markShown, marksRead, NO_MARK_READ_OPTION } from "./catch-up.js"
import { type Messenger, messengerContext } from "./context.js"
import {
  heardItems,
  hearForCommand,
  hearingFields,
  MODEL_OPTION,
  spokenItems,
  TRANSCRIBE_OPTION,
} from "./hearing-command.js"
import { checkPoints } from "./points.js"

const FIRST_LOOK_MS = 24 * 60 * 60 * 1000

export const PARTIAL_NOTE =
  "the messenger did not list every chat, and did not say how many it left out; one may have more"

/**
 * Two questions, one command — max-cli's `inbox` (its `NEED-171`).
 *
 * **Plain `inbox` — what is unread**, as the messenger counts it. For a person.
 *
 * **`--new` — what arrived since the last check.** For a scheduled run: the point it starts from is
 * kept per chat and moved only by a run that printed, so each message shows once, and a run that
 * fails shows it again rather than never (max-cli `NEED-162`). `lastCheckAt`, the first check, stays
 * put: it is where a chat never read yet starts, so a chat skipped by one run is not lost.
 * `--since-time` is a one-off look from a time of your choosing and leaves the points where they were.
 */
export const inboxCommand = (messenger: Messenger): Command =>
  new Command("inbox")
    .description("other people's unread messages in every chat; --new for what arrived since the last check")
    .option("--new", "what arrived since the last check, each message once — for scheduled runs")
    .option("--since-time <time>", "what arrived after this ISO 8601 time, or 2h / 1d ago; the saved point stays put")
    .option("--limit <n>", "at most this many per chat, the newest", positiveCount("--limit"))
    .option("--all", "muted and archived chats too — left out unless they mention you or reply to you")
    .option("--kind <kinds>", `only chats of these kinds, comma-separated: ${CHAT_KINDS.join(", ")}`)
    .option(...TRANSCRIBE_OPTION)
    .option(...MODEL_OPTION)
    .option(...MARK_READ_OPTION)
    .option(...NO_MARK_READ_OPTION)
    .action(async function (this: Command) {
      const {
        new: fresh,
        sinceTime: since,
        all,
        kind,
        transcribe,
        model,
        markRead,
      } = this.opts<{
        new?: boolean
        sinceTime?: string
        all?: boolean
        kind?: string
        transcribe?: boolean
        model?: string
        markRead?: boolean
      }>()
      const hearWith = modelWith(transcribe, model)
      const context = messengerContext(this, messenger)
      const { app } = messenger
      const { settings, renderer, format, streams, env } = context
      const kinds = kind === undefined ? undefined : kindsOf(kind)
      const saved =
        fresh && since === undefined
          ? checkPoints(app, { command: "inbox", profile: settings.profile, env, firstLookMs: FIRST_LOOK_MS })
          : undefined
      const from = since !== undefined ? momentOf(since, "--since-time") : saved?.first
      const points = saved?.chats
      const marking = marksRead(markRead, settings)
      const { inbox, read, hearing, marked } = await context.withServices(async (services, connect) => {
        const inbox = await services.inbox.read({
          ...(from === undefined ? {} : { since: from }),
          ...(points === undefined ? {} : { points }),
          ...(kinds === undefined ? {} : { kinds }),
          limit: settings.limit,
          all: all === true,
        })
        const read: MessageHit[] = inbox.chats.flatMap((chat) =>
          chat.messages.map((message) => ({ ...message, chatTitle: chat.title })),
        )
        const hearing = await hearForCommand(context, messenger, read, transcribe === true, hearWith, connect)
        const marked = marking ? await markShown(services, inbox.chats) : undefined
        return { inbox, read, hearing, marked }
      })

      for (const chat of inbox.chats) {
        if (chat.more) {
          renderer.note(
            `${chat.title ?? chat.id}: only the newest shown — \`${app.command} messages list ${chat.id}\` for more`,
          )
        }
      }
      if (inbox.skipped.length > 0) {
        const names = inbox.skipped.map((chat) => chat.title ?? chat.id).join(", ")
        renderer.note(
          `skipped ${inbox.skipped.length} chats — too many at once: ${names} — \`${app.command} messages list <chat>\` reads one`,
        )
      }
      if (inbox.quiet > 0) renderer.note(`${inbox.quiet} muted or archived chats left out — --all shows them`)
      if (inbox.partial) renderer.note(PARTIAL_NOTE)
      if (marked !== undefined) renderer.note(`marked ${marked.length} chat(s) read up to the newest message shown`)

      const messages = heardItems(read, hearing)
      if (format === "jsonl") renderer.stream(messages)
      else if (format !== "pretty") {
        renderer.result({
          ...inbox,
          ...(marked === undefined ? {} : { markedRead: marked }),
          chats: inbox.chats.map((chat) => ({ ...chat, messages: heardItems(chat.messages, hearing) })),
          ...hearingFields(hearing, transcribe === true),
        })
      } else if (messages.length === 0) {
        renderer.note(inbox.mode === "unread" ? "nothing unread" : `nothing new since ${inbox.since}`)
      } else {
        messages.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
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

      saved?.save(inbox.checked ?? {})
    })
