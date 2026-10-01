import type { Id, Message } from "../domain/models.js"

export const RULES_VERSION = 3

/** How far back a rule looks, in messages: 97% of reply parents sat within 50 in a measured group. */
export const LOOK_BACK = 50

// Tuned on the IRC dev split (bench/disentangle/sweep.ts); wider windows gained nothing.
const SAME_SENDER_WITHIN = 10
const SAME_SENDER_MS = 5 * 60_000

export type LinkInput = Pick<Message, "id" | "senderId" | "text" | "timestamp" | "replyToId" | "threadId" | "mentions">

export interface Link {
  messageId: Id
  parentId: Id
  source: "provider" | "rule"
  kind: "reply" | "mention" | "same_sender"
  confidence: number
  method: string
}

export interface Linked {
  links: Link[]
  /** Each message's chosen parent; `null` starts a conversation. */
  parents: Map<Id, Id | null>
  /** Message ids, each conversation oldest first, conversations in the order they started. */
  conversations: Id[][]
}

export interface LinkOptions {
  /** A handle as people type it, without `@` and lowercased, to the sender it names. */
  handles?: ReadonlyMap<string, Id>
}

/**
 * Links each message to the earlier one it answers, from the messenger's replies and a few rules, and
 * groups the chosen parents into conversations. `messages` must be one chat, oldest first.
 */
export const linkMessages = (messages: Iterable<LinkInput>, { handles = new Map() }: LinkOptions = {}): Linked => {
  const links: Link[] = []
  const parents = new Map<Id, Id | null>()
  const conversationOf = new Map<Id, number>()
  const conversations: Id[][] = []
  const window: LinkInput[] = []

  for (const message of messages) {
    const found = [
      ...replyLink(message, conversationOf),
      ...mentionLinks(message, window, handles),
      ...sameSenderLink(message, window),
    ]
    links.push(...found)
    const parent = choose(found)
    parents.set(message.id, parent)

    const conversation = parent === null ? conversations.length : (conversationOf.get(parent) as number)
    if (conversation === conversations.length) conversations.push([])
    conversations[conversation]?.push(message.id)
    conversationOf.set(message.id, conversation)

    window.push(message)
    if (window.length > LOOK_BACK) window.shift()
  }
  return { links, parents, conversations }
}

const replyLink = (message: LinkInput, held: ReadonlyMap<Id, number>): Link[] =>
  message.replyToId !== undefined && held.has(message.replyToId)
    ? [link(message, message.replyToId, "provider", "reply", 1, "reply")]
    : []

const mentionLinks = (message: LinkInput, window: LinkInput[], handles: ReadonlyMap<string, Id>): Link[] => {
  const links: Link[] = []
  const people = new Set([...mentioned(message.text, handles)].flatMap((handle) => handles.get(handle) ?? []))
  for (const id of message.mentions ?? []) people.add(id)
  for (const sender of people) {
    if (sender === message.senderId) continue
    const target = latest(window, (candidate) => candidate.senderId === sender && sameThread(candidate, message))
    if (target) links.push(link(message, target.id, "rule", "mention", 0.8, "mention-v1"))
  }
  return links
}

const sameSenderLink = (message: LinkInput, window: LinkInput[]): Link[] => {
  if (message.senderId === null) return []
  const at = Date.parse(message.timestamp)
  const target = latest(
    window.slice(-SAME_SENDER_WITHIN),
    (candidate) =>
      candidate.senderId === message.senderId &&
      sameThread(candidate, message) &&
      at - Date.parse(candidate.timestamp) <= SAME_SENDER_MS,
  )
  return target ? [link(message, target.id, "rule", "same_sender", 0.5, "same-sender-v2")] : []
}

/** `@handle` anywhere, or a known handle opening the message as IRC and many groups address people: `ana: …`. */
const mentioned = (text: string, handles: ReadonlyMap<string, Id>): Set<string> => {
  const found = new Set<string>()
  for (const [, handle] of text.matchAll(/@([\p{L}\p{N}_]{2,})/gu)) if (handle) found.add(handle.toLowerCase())
  const opening = /^\s*([^\s:,]{2,})[:,]\s/u.exec(text)?.[1]?.toLowerCase()
  if (opening !== undefined && handles.has(opening)) found.add(opening)
  return found
}

/** The messenger's reply first, then the most confident rule; on a tie, the one found first. */
const choose = (links: Link[]): Id | null => {
  const provider = links.find((one) => one.source === "provider")
  if (provider) return provider.parentId
  let best: Link | undefined
  for (const one of links) if (!best || one.confidence > best.confidence) best = one
  return best?.parentId ?? null
}

const latest = (window: LinkInput[], matches: (candidate: LinkInput) => boolean): LinkInput | undefined => {
  for (let index = window.length - 1; index >= 0; index--) {
    const candidate = window[index]
    if (candidate && matches(candidate)) return candidate
  }
  return undefined
}

const sameThread = (a: LinkInput, b: LinkInput) => a.threadId === b.threadId

const link = (
  message: LinkInput,
  parentId: Id,
  source: Link["source"],
  kind: Link["kind"],
  confidence: number,
  method: string,
): Link => ({ messageId: message.id, parentId, source, kind, confidence, method })
