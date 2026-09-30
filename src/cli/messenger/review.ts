import { CliError } from "@leemour/cli-core"
import { Command } from "commander"
import type { Id, Message, MessageHit, Review, ReviewChat } from "../../domain/models.js"
import { renderMessages } from "../../render/messages.js"
import { type Messenger, messengerContext } from "./context.js"
import { byRecency, CHAT_WINDOW, capped, heard, momentOf } from "./inbox.js"
import type { MessengerAdapter } from "./port.js"

/** Owner's ruling in max-cli: without a boundary, a review looks at the last three days. */
export const REVIEW_DAYS = 3
export const UNANSWERED_HOURS = 24
/** Every page is a history request; 20 chats of 3 pages stays well inside what one account may ask. */
export const REVIEW_CHATS = 20
const REVIEW_PAGE = 100
const REVIEW_PER_CHAT = 300

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

export interface ReviewOptions {
  since: number
  /** A chat as typed; only that one is read, muted or not. */
  chat?: string
  all?: boolean
  /** Keep only questions nobody answered in this many hours. */
  unansweredAfterHours?: number
  now?: number
}

/**
 * The chat's messages after `since` and up to `cut`, oldest first. The history pages backwards —
 * Telegram's cannot start from a time — so a chat cut short keeps its newest, and the review is
 * incomplete rather than silently missing the start.
 */
const window = async (adapter: MessengerAdapter, chat: Id, since: number, cut: number) => {
  const messages: Message[] = []
  let before: string | undefined
  while (true) {
    const page = await adapter.history(chat, { limit: REVIEW_PAGE, ...(before === undefined ? {} : { before }) })
    const time = (message: Message) => Date.parse(message.timestamp)
    messages.unshift(...page.items.filter((message) => time(message) > since && time(message) <= cut))
    const oldest = page.items[0]
    if (!page.hasMore || !oldest || time(oldest) <= since) return { messages, more: false }
    if (messages.length >= REVIEW_PER_CHAT) return { messages: messages.slice(-REVIEW_PER_CHAT), more: true }
    before = oldest.id
  }
}

/**
 * **Every message, both sides, in each chat that changed after `since`** — what a review of who
 * owes what reads, where `inbox` reads only other people's newest few. Cut at the chat list's newest
 * message, as `inbox --new` is, so the next review starting at `until` misses nothing.
 */
export const reviewIn = async (
  adapter: MessengerAdapter,
  { since, chat, all = false, unansweredAfterHours, now = Date.now() }: ReviewOptions,
): Promise<Review> => {
  const page = await adapter.chats({ limit: CHAT_WINDOW, offset: 0 })
  const changed = byRecency(
    page.items.filter((one) => one.lastMessageAt !== null && Date.parse(one.lastMessageAt) > since),
  )
  const cut = Math.max(since, ...changed.map((one) => Date.parse(one.lastMessageAt ?? "")))
  const only = chat === undefined ? undefined : (await adapter.resolve(chat)).id
  const { heard: wanted, quiet } =
    only === undefined ? heard(changed, all) : { heard: changed.filter((one) => one.id === only), quiet: 0 }
  const { read, skipped } = capped(wanted, REVIEW_CHATS)

  const chats: ReviewChat[] = []
  for (const { id, title, kind } of read) {
    const { messages, more } = await window(adapter, id, since, cut)
    if (messages.length > 0) chats.push({ id, title, kind, messages, more })
  }
  const partial = page.hasMore && changed.length === page.items.length
  const found: Review = {
    since: new Date(since).toISOString(),
    until: new Date(cut).toISOString(),
    complete: skipped.length === 0 && !partial && chats.every((one) => !one.more),
    chats,
    skipped,
    partial,
    quiet,
  }
  if (unansweredAfterHours === undefined) return found

  const open: ReviewChat[] = []
  for (const one of chats) {
    const admins = one.kind === "dialog" ? [] : ((await adapter.admins?.(one.id)) ?? undefined)
    const questions = unanswered(one.messages, {
      answerers: new Set(admins ?? []),
      before: now - unansweredAfterHours * 3_600_000,
    })
    if (questions.length > 0) {
      open.push({ ...one, messages: questions, answeredBy: admins === undefined ? "owner" : "owner-and-admins" })
    }
  }
  return { ...found, chats: open, unanswered: { olderThanHours: unansweredAfterHours } }
}

/** A shared link's query string is not a question. */
const LINKS = /https?:\/\/\S+/g

/**
 * Questions from others still waiting, as max-cli counts them. A question is a message with `?` in
 * it, or a reply to the owner or an admin. It is answered when one of them replied to it, or was the
 * next to speak after the person who asked — "the next to speak" rather than "spoke later", because
 * in a busy group an admin answering somebody else says nothing about this question.
 */
export const unanswered = (
  messages: Message[],
  { answerers, before }: { answerers: ReadonlySet<Id>; before: number },
): Message[] => {
  const answers = (message: Message) =>
    message.outgoing === true || (message.senderId !== null && answerers.has(message.senderId))
  const byId = new Map(messages.map((message) => [message.id, message]))
  // Telegram names only the id a reply answers; the message itself is found in the window, or not at all.
  const repliesToAnswerer = (message: Message) => {
    const to = message.replyTo?.id ?? message.replyToId
    const quoted = to === undefined ? undefined : byId.get(to)
    if (quoted) return answers(quoted)
    return (
      message.replyTo !== null && (message.replyTo.outgoing === true || answerers.has(message.replyTo.senderId ?? ""))
    )
  }

  return messages.filter((message, index) => {
    if (answers(message) || Date.parse(message.timestamp) >= before) return false
    if (!message.text.replace(LINKS, "").includes("?") && !repliesToAnswerer(message)) return false
    const later = messages.slice(index + 1)
    if (later.some((reply) => (reply.replyTo?.id ?? reply.replyToId) === message.id && answers(reply))) return false
    const next = later.find((other) => other.senderId !== message.senderId)
    return !(next && answers(next))
  })
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
    .action(async function (this: Command) {
      const options = this.opts<{ since?: string; chat?: string; unanswered?: string | true; all?: boolean }>()
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

      const messages: MessageHit[] = found.chats.flatMap((chat) =>
        chat.messages.map((message) => ({ ...message, chatTitle: chat.title })),
      )
      if (format === "jsonl") renderer.stream(messages)
      else if (format !== "pretty") renderer.result(found)
      else if (messages.length > 0) {
        streams.data(
          renderMessages(messages, {
            color: context.color,
            verbosity: settings.detail,
            senderColors: settings.senderColors,
            profile: context.profile,
            provider: messenger.provider,
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
