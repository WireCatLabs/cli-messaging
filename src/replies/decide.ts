import type { Chat, Id, Message } from "../domain/models.js"
import { DAYS, type Day, type Limit, type ReplyAction, type ReplyRule, type Window } from "./rules.js"
import { answeredKey, type RepliesState } from "./state.js"

/** What the matcher knows about one arriving message beyond the message itself. */
export interface Incoming {
  message: Message
  chat: Pick<Chat, "id" | "kind">
  /** The owner, to tell a mention or a reply to them; `null` when the account is not known. */
  owner: { id: Id | null; username?: string }
  sender: { isBot: boolean; isContact: boolean }
  /** Why the file's audience lets no answer go to this sender in this chat, or `null` when it does; a task opens for anyone. */
  outside: string | null
  /** ms: when `serve` began catching up. Older messages are never answered — a week away must not get a week of replies. */
  since: number
}

/** `reply` is `null` when the rule only opens a task, or the sender may get no answer. */
export type Decision =
  | { actions: ReplyAction[]; reply: { text: string; asReply: boolean; model: ReplyRule["reply"]["model"] } | null }
  | { skip: string }

const skip = (why: string): Decision => ({ skip: why })

/**
 * Whether `rule` answers this message at `now`, and with what — or why not, in words `replies test`
 * can print. Pure: it reads `state` and changes nothing; the caller records a reply it sent.
 */
export const decide = (rule: ReplyRule, incoming: Incoming, state: RepliesState, now: number): Decision => {
  const { message, chat, owner, sender } = incoming
  if (state.paused) return skip("replies are paused")
  if (!rule.on) return skip("the rule is off")
  if (message.outgoing !== false) return skip(message.outgoing ? "your own message" : "the account is not known")
  if (message.senderIsChat || message.senderId === null) return skip("sent as a chat, not by a person")
  // A task stays on this machine; only an answer to a person needs the audience to allow them.
  const { outside: why } = incoming
  if (why !== null && !rule.do.includes("task")) return skip(why)
  const actions = why === null ? rule.do : rule.do.filter((action) => action !== "reply")
  if (sender.isBot) return skip("sent by a bot")
  if (chat.kind !== "dialog" && chat.kind !== "group") return skip(`a ${chat.kind} is never answered`)
  if (message.editedAt !== null) return skip("an edited message")
  if (message.scheduledFor !== undefined) return skip("a scheduled message")
  if (Date.parse(message.timestamp) < incoming.since) return skip("older than the catch-up start")
  if (state.answered.includes(answeredKey(message))) return skip("already answered")

  const { where, when } = rule
  if (where.kinds.length > 0 && !where.kinds.includes(chat.kind)) return skip(`the rule does not answer a ${chat.kind}`)
  if (where.chats.length > 0 && !where.chats.includes(chat.id)) return skip("not one of the rule's chats")
  if (where.notChats.includes(chat.id)) return skip("one of the chats the rule leaves out")
  const toMe = mentionsOwner(message, owner)
  if (chat.kind === "group" && !where.chats.includes(chat.id) && !toMe) {
    return skip("a group message that neither mentions you nor replies to you")
  }

  if (when.hours && !outside(when.hours, now)) return skip("inside the hours the rule leaves alone")
  if (when.words.length > 0 && !when.words.some((word) => hasWord(message.text, word))) {
    return skip("none of the rule's words")
  }
  if (when.question && !isQuestion(message.text)) return skip("not a question")
  if (when.mentionsMe && !toMe) return skip("does not mention you or reply to you")
  const { from } = when
  if (from.people.length > 0 && !from.people.includes(message.senderId)) return skip("not from the rule's people")
  if (from.notPeople.includes(message.senderId)) return skip("from a person the rule leaves out")
  if (from.contactsOnly && !sender.isContact) return skip("not from a contact")

  const sent = state.sent[rule.id]
  if (over(sent?.chats[chat.id], rule.limits.perChat, now)) return skip("the chat's limit is reached")
  if (over(sent?.people[message.senderId], rule.limits.perPerson, now)) return skip("the person's limit is reached")

  if (!actions.includes("reply")) return { actions, reply: null }
  if (rule.reply.template.trim() === "") {
    const rest = actions.filter((action) => action !== "reply")
    return rest.length === 0 ? skip("the reply template is empty") : { actions: rest, reply: null }
  }
  const text = filled(rule.reply.template, message.senderName)
  if (text === undefined) {
    const rest = actions.filter((action) => action !== "reply")
    return rest.length === 0
      ? skip("the template needs a name the sender has not given")
      : { actions: rest, reply: null }
  }
  return { actions, reply: { text, asReply: rule.reply.asReply, model: rule.reply.model } }
}

const mentionsOwner = (message: Message, owner: Incoming["owner"]): boolean =>
  message.replyTo?.outgoing === true ||
  (owner.id !== null && (message.mentions ?? []).includes(owner.id)) ||
  (owner.username !== undefined && hasWord(message.text, `@${owner.username}`))

const local = (zone: string, now: number): { day: Day; minute: number } => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now)
  const part = (type: string) => parts.find((one) => one.type === type)?.value ?? ""
  return {
    day: part("weekday").toLowerCase() as Day,
    minute: Number(part("hour")) * 60 + Number(part("minute")),
  }
}

/**
 * Outside the working time: not on one of `days`, or on one but not inside the window. A window that
 * crosses midnight belongs to the day it starts on, so Friday 22:00–02:00 covers Saturday 01:00.
 */
const outside = (
  { outside: window, days, timezone }: { outside: Window; days: Day[]; timezone: string },
  now: number,
) => {
  const { day, minute } = local(timezone, now)
  const crosses = window.to < window.from
  const working = crosses
    ? (days.includes(day) && minute >= window.from) || (days.includes(dayBefore(day)) && minute < window.to)
    : days.includes(day) && minute >= window.from && minute < window.to
  return !working
}

const dayBefore = (day: Day): Day => DAYS[(DAYS.indexOf(day) + 6) % 7] as Day

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Whole words, any case, any script: `price` is not found in `prices`, `цена` is found in `Цена?`. */
const hasWord = (text: string, word: string): boolean =>
  new RegExp(`(?<![\\p{L}\\p{N}_])${escaped(word.trim())}(?![\\p{L}\\p{N}_])`, "iu").test(text)

/** A shared link's query string is not a question. */
const isQuestion = (text: string): boolean => text.replace(/https?:\/\/\S+/g, "").includes("?")

const over = (sent: string[] | undefined, { count, ms }: Limit, now: number): boolean =>
  (sent ?? []).filter((at) => now - Date.parse(at) < ms).length >= count

const filled = (template: string, senderName: string | null): string | undefined => {
  const name = senderName?.trim() ?? ""
  if (/\{(firstName|name)\}/.test(template) && name === "") return undefined
  return template.replaceAll("{firstName}", name.split(/\s+/)[0] ?? name).replaceAll("{name}", name)
}
