import { readFileSync } from "node:fs"
import { join } from "node:path"
import { resolvePaths, writeSecurely } from "@leemour/cli-core"
import { Command } from "commander"
import type { MessageHit } from "../../domain/models.js"
import { renderMessages } from "../../render/messages.js"
import { CHAT_WINDOW } from "../../services/inbox.js"
import { momentOf } from "../../services/moment.js"
import { modelWith } from "../../speech/hearing.js"
import type { AppIdentity } from "../app.js"
import { positiveCount } from "../paging.js"
import { type Messenger, messengerContext } from "./context.js"
import {
  heardItems,
  hearForCommand,
  hearingFields,
  MODEL_OPTION,
  spokenItems,
  TRANSCRIBE_OPTION,
} from "./hearing-command.js"

const FIRST_LOOK_MS = 24 * 60 * 60 * 1000

/** Where `inbox --new` stopped, per profile, beside the remembered account. */
const pointFileFor = (app: AppIdentity, profile: string, env: NodeJS.ProcessEnv): string =>
  join(resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).state, "inbox", `${profile}.json`)

const savedPoint = (app: AppIdentity, profile: string, env: NodeJS.ProcessEnv): string | undefined => {
  try {
    const { lastCheckAt } = JSON.parse(readFileSync(pointFileFor(app, profile, env), "utf8")) as {
      lastCheckAt?: unknown
    }
    return typeof lastCheckAt === "string" ? lastCheckAt : undefined
  } catch {
    return undefined
  }
}

/**
 * Two questions, one command — max-cli's `inbox` (its `NEED-171`).
 *
 * **Plain `inbox` — what is unread**, as the messenger counts it. For a person.
 *
 * **`--new` — what arrived since the last check.** For a scheduled run: the point it starts from is
 * kept per profile and moved only by a run that printed, so each message shows once, and a run
 * that fails shows it again rather than never (max-cli `NEED-162`). `--since` is a one-off look
 * from a time of your choosing and leaves that point where it was.
 */
export const inboxCommand = (messenger: Messenger): Command =>
  new Command("inbox")
    .description("other people's unread messages in every chat; --new for what arrived since the last check")
    .option("--new", "what arrived since the last check, each message once — for scheduled runs")
    .option("--since <time>", "what arrived after this ISO 8601 time, or 2h / 1d ago; the saved point stays put")
    .option("--limit <n>", "at most this many per chat, the newest", positiveCount("--limit"))
    .option("--all", "muted and archived chats too — left out unless they mention you or reply to you")
    .option(...TRANSCRIBE_OPTION)
    .option(...MODEL_OPTION)
    .action(async function (this: Command) {
      const {
        new: fresh,
        since,
        all,
        transcribe,
        model,
      } = this.opts<{
        new?: boolean
        since?: string
        all?: boolean
        transcribe?: boolean
        model?: string
      }>()
      const hearWith = modelWith(transcribe, model)
      const context = messengerContext(this, messenger)
      const { app } = messenger
      const { settings, renderer, format, streams, env } = context
      const saved = savedPoint(app, settings.profile, env)
      const from =
        since !== undefined
          ? momentOf(since)
          : fresh
            ? saved === undefined
              ? Date.now() - FIRST_LOOK_MS
              : Date.parse(saved)
            : undefined
      const inbox = await context.withServices((services) =>
        services.inbox.read({
          ...(from === undefined ? {} : { since: from }),
          limit: settings.limit,
          all: all === true,
        }),
      )

      for (const chat of inbox.chats) {
        if (chat.more) {
          renderer.note(
            `${chat.title ?? chat.id}: only the newest shown — \`${app.command} messages list ${chat.id}\` for more`,
          )
        }
      }
      if (inbox.skipped.length > 0) {
        const names = inbox.skipped.map((chat) => chat.title ?? chat.id).join(", ")
        renderer.note(`not read — too many chats at once: ${names} — \`${app.command} messages list <chat>\` reads one`)
      }
      if (inbox.quiet > 0) renderer.note(`${inbox.quiet} muted or archived chats left out — --all shows them`)
      if (inbox.partial)
        renderer.note(`only the ${CHAT_WINDOW} newest chats were looked at; an older one may have more`)

      const read: MessageHit[] = inbox.chats.flatMap((chat) =>
        chat.messages.map((message) => ({ ...message, chatTitle: chat.title })),
      )
      const hearing = await hearForCommand(context, messenger, read, transcribe === true, hearWith)
      const messages = heardItems(read, hearing)
      if (format === "jsonl") renderer.stream(messages)
      else if (format !== "pretty") {
        renderer.result({
          ...inbox,
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

      if (fresh && since === undefined && inbox.until !== undefined && inbox.until !== inbox.since) {
        writeSecurely(
          pointFileFor(app, settings.profile, env),
          `${JSON.stringify({ lastCheckAt: inbox.until })}\n`,
          0o600,
        )
      }
    })
