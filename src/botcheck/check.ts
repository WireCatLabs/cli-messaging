import type { Id, Message } from "../domain/models.js"
import { type BotReason, LINK, oddName, WEIGHTS } from "./reasons.js"
import type { RegistryAnswer } from "./registries.js"

const DAY_MS = 86_400_000
/** Younger than this is `new_account` or `photo_recent`. */
export const NEW_DAYS = 30
/** Shorter texts repeat honestly — "thanks", "ok", a sticker's caption. */
const SAME_TEXT_MIN = 20

/** What the messenger says about the person, as much as it said. A field left out is not known. */
export interface BotSubject {
  id: Id
  name: string | null
  usernames: readonly string[]
  bio?: string | null
  flags?: Partial<Record<"bot" | "scam" | "fake" | "deleted", boolean>>
  hasPhoto?: boolean
  registered?: { at: string; source: string } | null
}

/** Their stored messages, newest first; `complete` when every stored one was read. */
export interface StoredActivity {
  messages: Pick<Message, "chatId" | "text" | "timestamp" | "forwardedFrom">[]
  complete: boolean
  /** Chats shared with them that the store holds anything of. */
  chatsStored: number
}

export interface PhotoFacts {
  count: number
  /** The oldest photo they still show; an upper bound on the account's age, since photos get deleted. */
  oldestAt: string | null
}

export interface CheckedReason {
  reason: BotReason
  weight: number
  /** Where it was read: `messenger`, `store`, `telegram` / `max` / `estimate` for a registration, `registry:<name>`. */
  source: string
  detail?: string
}

export interface BotCheck {
  person: { id: Id; name: string | null; username: string | null; provider: string }
  score: number
  reasons: CheckedReason[]
  registries: RegistryAnswer[]
  /** Signals nothing could be read for — the messenger did not say, the store holds none, offline. */
  unknown: BotReason[]
  checkedAt: string
}

const normalized = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim()

/** The same text of theirs, long enough to mean something, in more than one chat. */
const repeated = (messages: StoredActivity["messages"]): number => {
  const chatsOf = new Map<string, Set<Id>>()
  for (const { text, chatId } of messages) {
    const key = normalized(text)
    if (key.length < SAME_TEXT_MIN) continue
    chatsOf.set(key, (chatsOf.get(key) ?? new Set()).add(chatId))
  }
  return Math.max(0, ...[...chatsOf.values()].map((chats) => chats.size))
}

/**
 * Every signal about one person, each with where it came from. A hint, never a verdict: the score is
 * a sum of light weights, and the reasons are what a person should read.
 */
export const scorePerson = ({
  subject,
  provider,
  activity,
  photos,
  registries,
  now = new Date(),
}: {
  subject: BotSubject
  provider: string
  activity?: StoredActivity
  photos?: PhotoFacts
  registries: RegistryAnswer[]
  now?: Date
}): BotCheck => {
  const reasons: CheckedReason[] = []
  const unknown: BotReason[] = []
  const add = (reason: BotReason, source: string, detail?: string) =>
    reasons.push({ reason, weight: WEIGHTS[reason], source, ...(detail ? { detail } : {}) })
  const young = (at: string) => now.getTime() - Date.parse(at) < NEW_DAYS * DAY_MS

  const { flags } = subject
  for (const flag of ["bot", "scam", "fake", "deleted"] as const) {
    if (flags?.[flag] === undefined) unknown.push(flag)
    else if (flags[flag]) add(flag, "messenger")
  }

  const withPhoto = subject.hasPhoto ?? (photos ? photos.count > 0 : undefined)
  if (withPhoto === undefined) unknown.push("no_photo")
  else if (!withPhoto) add("no_photo", "messenger")
  if (subject.usernames.length === 0) add("no_username", "messenger")
  if (oddName(subject.name)) add("odd_name", "messenger")
  if (subject.bio === undefined) unknown.push("no_bio")
  else if (!subject.bio?.trim()) add("no_bio", "messenger")

  if (subject.registered === undefined || subject.registered === null) unknown.push("new_account")
  else if (young(subject.registered.at)) add("new_account", subject.registered.source, subject.registered.at)

  if (photos === undefined) unknown.push("photo_recent")
  else if (photos.oldestAt && young(photos.oldestAt)) add("photo_recent", "messenger", photos.oldestAt)

  if (activity === undefined || activity.chatsStored === 0) unknown.push("never_wrote", "link_first", "same_text")
  else {
    const { messages, complete } = activity
    if (messages.length === 0) add("never_wrote", "store")
    const first = complete ? messages.at(-1) : undefined
    if (!complete) unknown.push("link_first")
    else if (first && (first.forwardedFrom !== null || LINK.test(first.text))) add("link_first", "store")
    const chats = repeated(messages)
    if (chats > 1) add("same_text", "store", `one text in ${chats} chats`)
  }

  for (const answer of registries) {
    for (const reason of answer.reasons ?? []) add(reason, `registry:${answer.name}`, answer.detail)
  }

  return {
    person: { id: subject.id, name: subject.name, username: subject.usernames[0] ?? null, provider },
    score: reasons.reduce((total, { weight }) => total + weight, 0),
    reasons: reasons.sort((a, b) => b.weight - a.weight),
    registries,
    unknown,
    checkedAt: now.toISOString(),
  }
}
