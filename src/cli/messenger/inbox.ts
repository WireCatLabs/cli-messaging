import { readFileSync } from "node:fs"
import { join } from "node:path"
import { CliError, resolvePaths, writeSecurely } from "@leemour/cli-core"
import { Command } from "commander"
import type { Chat, Inbox, InboxChat, MessageHit } from "../../domain/models.js"
import { renderMessages } from "../../render/messages.js"
import type { AppIdentity } from "../app.js"
import { type Messenger, messengerContext } from "./context.js"
import { heardItems, hearForCommand, hearingFields, spokenItems, TRANSCRIBE_OPTION } from "./hearing-command.js"
import type { MessengerAdapter } from "./port.js"

/**
 * **At most this many history reads per `inbox`**, as in max-cli: a person opening twenty chats in
 * one burst is already more than a person does, and the rest are named in `skipped`, not lost.
 */
export const INBOX_CHATS = 20
/** The newest dialogs looked at. Walking every dialog hit FLOOD_WAIT once (tg handoff §4.14). */
export const CHAT_WINDOW = 100
const FIRST_LOOK_MS = 24 * 60 * 60 * 1000

export const byRecency = (chats: Chat[]): Chat[] =>
  chats.toSorted((a, b) => Date.parse(b.lastMessageAt ?? "") - Date.parse(a.lastMessageAt ?? ""))

/** Muted or archived, and nothing in it mentions the owner or replies to them. */
const isQuiet = (chat: Chat): boolean =>
  (chat.muted === true || chat.archived === true) && (chat.unreadMentions ?? 0) === 0

export const heard = (chats: Chat[], all: boolean) =>
  all
    ? { heard: chats, quiet: 0 }
    : { heard: chats.filter((chat) => !isQuiet(chat)), quiet: chats.filter(isQuiet).length }

export const capped = (chats: Chat[], most: number) => ({
  read: chats.slice(0, most),
  skipped: chats.slice(most).map(({ id, title, lastMessageAt }) => ({ id, title, lastMessageAt })),
})

/**
 * Other people's unread messages, as the messenger counts them: for each chat with a count, its
 * newest that many. Reading marks nothing read, so the same messages come back until they are read
 * somewhere else — right for a person, wrong for a scheduled run, which is what `since` is for.
 *
 * Muted and archived chats are left out unless `all`, or they mention the owner: on a busy account
 * they are most of what is unread, and they would take the history reads a person's chat needs.
 */
export const unreadIn = async (
  adapter: MessengerAdapter,
  { limit, all = false }: { limit: number; all?: boolean },
): Promise<Inbox> => {
  const page = await adapter.chats({ limit: CHAT_WINDOW, offset: 0 })
  const { heard: waiting, quiet } = heard(byRecency(page.items.filter((chat) => (chat.unreadCount ?? 0) > 0)), all)
  const { read, skipped } = capped(waiting, INBOX_CHATS)

  const chats: InboxChat[] = []
  for (const { id, title, kind, unreadCount } of read) {
    const count = unreadCount ?? 0
    const wanted = Math.min(count, limit)
    const { items } = await adapter.history(id, { limit: wanted })
    const theirs = items.slice(-wanted).filter((message) => !message.outgoing)
    if (theirs.length > 0) chats.push({ id, title, kind, unreadCount, messages: theirs, more: count > limit })
  }
  return { mode: "unread", chats, skipped, partial: page.hasMore, quiet }
}

/**
 * Other people's messages in every chat that changed after `since`.
 *
 * **Everything is cut at the chat list's newest message**, the snapshot taken first. The reads run
 * one after another, so a chat read early can gain a message while a later one is read; had the
 * saved point followed the later read, that message would sit behind it and never show. Anything
 * newer waits for the next run and shows once there.
 */
export const newIn = async (
  adapter: MessengerAdapter,
  { since, limit, all = false }: { since: number; limit: number; all?: boolean },
): Promise<Inbox> => {
  const page = await adapter.chats({ limit: CHAT_WINDOW, offset: 0 })
  const changed = byRecency(
    page.items.filter((chat) => chat.lastMessageAt !== null && Date.parse(chat.lastMessageAt) > since),
  )
  const cut = Math.max(since, ...changed.map((chat) => Date.parse(chat.lastMessageAt ?? "")))
  const { heard: wanted, quiet } = heard(changed, all)
  const { read, skipped } = capped(wanted, INBOX_CHATS)

  let until = since
  const chats: InboxChat[] = []
  for (const { id, title, kind, unreadCount } of read) {
    const { items } = await adapter.history(id, { limit })
    const fresh = items.filter((message) => {
      const time = Date.parse(message.timestamp)
      return time > since && time <= cut
    })
    for (const message of fresh) until = Math.max(until, Date.parse(message.timestamp))
    const theirs = fresh.filter((message) => !message.outgoing)
    if (theirs.length > 0) chats.push({ id, title, kind, unreadCount, messages: theirs, more: fresh.length >= limit })
  }

  return {
    mode: "new",
    since: new Date(since).toISOString(),
    until: new Date(until).toISOString(),
    chats,
    skipped,
    // Every dialog in the window changed, so an older one past it may have too.
    partial: page.hasMore && changed.length === page.items.length,
    quiet,
  }
}

const AGO = /^(\d+)(m|h|d)$/
const AGO_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 }

/**
 * `--since` as a moment: ISO 8601, or `30m`, `2h`, `1d` ago. Unlike max-cli, never a message id —
 * a MAX id carries its time, and a Telegram id is only a counter within one chat.
 */
export const momentOf = (reference: string, flag = "--since", now = Date.now()): number => {
  const wanted = reference.trim()
  const [, amount, unit] = AGO.exec(wanted) ?? []
  // By shape: `Date.parse("12345")` is the year 12345, so a message id would pass as a date.
  const time =
    amount && unit
      ? now - Number(amount) * (AGO_MS[unit] ?? 0)
      : /^\d{4}-\d{2}-\d{2}/.test(wanted)
        ? Date.parse(wanted)
        : Number.NaN
  if (Number.isNaN(time)) {
    throw new CliError("validation_error", `${flag} takes an ISO 8601 time or 30m, 2h, 1d ago — not "${wanted}"`)
  }
  return time
}

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
    .option("--limit <n>", "at most this many per chat, the newest", (value) => Number.parseInt(value, 10))
    .option("--all", "muted and archived chats too — left out unless they mention you or reply to you")
    .option(...TRANSCRIBE_OPTION)
    .action(async function (this: Command) {
      const {
        new: fresh,
        since,
        all,
        transcribe,
      } = this.opts<{
        new?: boolean
        since?: string
        all?: boolean
        transcribe?: boolean
      }>()
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
      const hearing = await hearForCommand(context, messenger, read, transcribe === true)
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
