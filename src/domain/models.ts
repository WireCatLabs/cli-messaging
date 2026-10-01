/**
 * What every messenger CLI built on this package promises. **Raw provider objects never reach
 * output**: wire shapes change without notice and carry fields whose meaning nobody knows. An
 * adapter translates into these types; everything above it speaks only them.
 *
 * A field is here only when more than one messenger has it. What only one provider has travels in
 * `providerMetadata`, so a shared type never grows a field that means nothing elsewhere.
 */

/** Every id is a string, never a number: provider ids are 64-bit, and an id is not arithmetic. */
export type Id = string

/** `telegram`, `max`… Open, because a new adapter must not need a change here. */
export type Provider = string

/** Whatever one provider knows that the shared model has no field for. */
export type ProviderMetadata = Record<string, unknown>

/** `saved` is the account's notes-to-self chat. */
export type ChatKind = "dialog" | "group" | "channel" | "saved" | "unknown"

/** Where the owner stands in a chat. Kept apart from whether its messages are searchable: a chat left keeps them. */
export type MembershipState = "joined" | "left" | "public" | "imported" | "archived" | "external"

export interface Chat {
  id: Id
  title: string | null
  kind: ChatKind
  /** `null` means the provider did not say, which is not the same as zero. */
  unreadCount: number | null
  /** ISO 8601, or `null` when the chat has never had a message. */
  lastMessageAt: string | null
  participantsCount: number | null
  /** Absent where the messenger does not say. */
  muted?: boolean
  archived?: boolean
  /** Unread messages that mention the owner or reply to them. */
  unreadMentions?: number
  /** Absent where the messenger does not say. */
  membershipState?: MembershipState
  providerMetadata?: ProviderMetadata
}

/** A group's switches; `null` where the messenger does not say, or has no such switch. */
export interface GroupSettings {
  allCanPin: boolean | null
  onlyAdminsAdd: boolean | null
  onlyAdminsCall: boolean | null
  onlyOwnerEditsInfo: boolean | null
  membersSeeLink: boolean | null
}

/** What `chats update` changes; a field left out stays as it is. */
export interface GroupChange {
  title?: string
  description?: string
  settings?: Partial<GroupSettings>
}

export const GROUP_SETTINGS = [
  "allCanPin",
  "onlyAdminsAdd",
  "onlyAdminsCall",
  "onlyOwnerEditsInfo",
  "membersSeeLink",
] as const

/** One line of `contacts import`: a phone number as digits, and the name to save it under. */
export interface PhoneBookEntry {
  phone: string
  name: string
}

/** A chat folder. */
export interface Folder {
  id: string
  title: string
  /** Chats added to it by hand; a folder that selects chats by a rule of its own lists none. */
  chatIds: Id[]
}

/** What `chats folders update` changes; chats by id. */
export interface FolderChange {
  title?: string
  add?: Id[]
  remove?: Id[]
}

/** What an admin may do, in max-cli's words; a messenger maps them onto its own. */
export const ADMIN_RIGHTS = ["read", "members", "admins", "info", "pin", "link", "post", "edit", "delete"] as const

export type AdminRight = (typeof ADMIN_RIGHTS)[number]

/** A group or channel as the commands that change one answer it. */
export interface GroupCard extends Chat {
  description: string | null
  /** The invite link; only a member who may see it gets one. */
  link: string | null
  settings: GroupSettings
}

export interface Attachment {
  /** Lower-cased: `photo`, `video`, `file`, `voice`, `sticker`, `share`… */
  kind: string
  /** A link that opens the bytes or the shared page, when the provider hands one out. */
  url?: string
  width?: number
  height?: number
  /** A shared page's title. */
  title?: string
  name?: string
  size?: number
  mime?: string
  /** Seconds, for audio and video. */
  duration?: number
  /** What the adapter needs to fetch the bytes later. Opaque above the adapter. */
  providerRef?: ProviderMetadata
}

/** Where one attachment's bytes can be fetched. */
export interface AttachmentLink {
  kind: string
  url: string
  name?: string
  /** The provider flags the file as possibly harmful. */
  unsafe?: boolean
}

/** What a chat has pinned after `messages pin` or `unpin`; `null` is nothing. */
export interface Pin {
  chatId: Id
  pinned: Id | null
}

/** What `messages delete` asked the provider to remove, and for whom. */
export interface Deletion {
  chatId: Id
  deleted: Id[]
  forEveryone: boolean
}

/** One answer of a poll. `id` is the provider's own, not a position: a vote names it. */
export interface PollAnswer {
  id: Id
  text: string
  /** `null` until the owner has voted or the poll is closed — the provider does not say before. */
  voters: number | null
  chosen: boolean
}

/** A poll as the message that carries it has it now. */
export interface Poll {
  chatId: Id
  messageId: Id
  question: string
  answers: PollAnswer[]
  closed: boolean
  multiple: boolean
  /** Nobody sees who voted for what. */
  anonymous: boolean
  voters: number | null
}

/** A chat marked read up to `messageId`, inclusive. `unread` is what the provider says is left, or `null`. */
export interface ReadMark {
  chatId: Id
  messageId: Id
  unread: number | null
}

/** The reactions on one message, as the provider counts them. */
export interface Reactions {
  counts: { reaction: string; count: number }[]
  /** This account's own reaction, or `null`. */
  mine: string | null
  total: number
}

/** The message a reply answers or a forward carries. */
export interface QuotedMessage {
  id: Id
  senderId: Id | null
  senderName: string | null
  /** ISO 8601, or `null` when the quote did not say. */
  timestamp: string | null
  text: string
  attachments: Attachment[]
  /** Whether this account wrote it. `null` when we do not know who we are. */
  outgoing: boolean | null
}

export interface Message {
  id: Id
  chatId: Id
  senderId: Id | null
  senderName: string | null
  /** The sender's handle without `@`, where the messenger has one: what people type to mention them. */
  senderUsername?: string
  /** `senderId` is a chat, not a person — a channel post, or a message sent as the group. */
  senderIsChat?: boolean
  /** ISO 8601. */
  timestamp: string
  /**
   * When the provider last recorded an edit, or `null` for a message nobody has changed. Surfaced
   * because a reader has no other way to tell an edited message from the original, and because it
   * is what a store compares to decide whether its copy is still current.
   */
  editedAt: string | null
  text: string
  /** Whether this account sent it. `null` when we do not know who we are. */
  outgoing: boolean | null
  attachments: Attachment[]
  replyTo: QuotedMessage | null
  /**
   * The id a reply answers, also when the provider sent no copy of that message — Telegram sends
   * only the id, MAX the whole message. Reply chains are what research needs most.
   */
  replyToId?: Id
  forwardedFrom: QuotedMessage | null
  /** The topic or thread inside the chat, where the provider has them. */
  threadId?: Id
  /** `null` when nobody asked — offline, or the request failed. */
  reactions: Reactions | null
  /** ISO 8601 — when the provider will send it. Present only on a message still waiting in the queue. */
  scheduledFor?: string
  providerMetadata?: ProviderMetadata
}

/**
 * A message found by searching, carrying the chat's name as well as its id: a search spans every
 * chat, so an answer that named only the id would make the reader look each one up.
 */
export interface MessageHit extends Message {
  chatTitle: string | null
}

/** What happened to a message after it arrived, as `watch --events` prints it. */
export type MessageChange =
  | { event: "edit"; message: MessageHit }
  /** `chatId` is `null` where the provider does not say — Telegram's private chats and basic groups. */
  | { event: "delete"; chatId: Id | null; chatTitle: string | null; messageId: Id }
  | { event: "reaction"; chatId: Id; chatTitle: string | null; messageId: Id; reactions: Reactions }

/** What a listening connection reports: a new message, or a change to one. */
export type MessageEvent = { event: "message"; message: MessageHit } | MessageChange

/** One chat's share of `inbox`: other people's messages since the last check, oldest first. */
export interface InboxChat extends Pick<Chat, "id" | "title" | "kind" | "unreadCount"> {
  messages: Message[]
  /** There are more than `--limit`; these are the newest of them. */
  more: boolean
}

export interface Inbox {
  /** `unread` — what the provider counts unread; `new` — what arrived since the last check. */
  mode: "unread" | "new"
  /** ISO 8601, `new` only. `until` is where the next check starts. */
  since?: string
  until?: string
  chats: InboxChat[]
  /** Past the per-run cap on history requests, so not read. */
  skipped: Pick<Chat, "id" | "title" | "lastMessageAt">[]
  /** Only part of the chat list was looked at, and there may be more. */
  partial: boolean
  /** Muted or archived chats with something waiting, left out because nothing in them is for the owner. */
  quiet: number
}

/** One chat's share of `review`: both sides, oldest first, from `since` to `until`. */
export interface ReviewChat extends Pick<Chat, "id" | "title" | "kind"> {
  messages: Message[]
  /** The chat had more in the window than one review reads; the newest are here. */
  more: boolean
  /** `--unanswered` only: whose words count as an answer. `owner` where the messenger did not say who the admins are. */
  answeredBy?: "owner" | "owner-and-admins"
}

/** `review`: everything said since a point, for someone sorting out who owes what. */
export interface Review {
  /** ISO 8601. `until` is where the next review starts. */
  since: string
  until: string
  /** Nothing skipped or cut short: the next review may start at `until`. */
  complete: boolean
  chats: ReviewChat[]
  skipped: Pick<Chat, "id" | "title" | "lastMessageAt">[]
  partial: boolean
  /** Muted or archived chats that changed, left out because nothing in them is for the owner. */
  quiet: number
  /** `--unanswered`: only questions still open after this many hours are in `chats`. */
  unanswered?: { olderThanHours: number }
}

/** One change to who is in a chat, or to the chat itself, read from a service message. */
export interface ChatEvent {
  messageId: Id
  /** ISO 8601. */
  timestamp: string
  /** `join`, `leave`, `add`, `remove`, `create`, `title` or `pin`; a messenger may pass others through. */
  event: string
  by: { id: Id | null; name: string | null }
  people: { id: Id; name: string | null }[]
  /** `create` and `title` carry the chat's title. */
  title?: string
}

export interface ChatEvents {
  chatId: Id
  since: string
  /** Oldest first. */
  events: ChatEvent[]
  /** More history than one run reads; the newest are here. */
  more: boolean
}

export interface Contact {
  id: Id
  name: string | null
  /** The public handle, without `@`, when they have one. */
  username: string | null
  /** Whatever they wrote about themselves. */
  description: string | null
  /**
   * The newest message in a one-to-one chat with them, ISO 8601, and `null` for somebody met only
   * in a group. It is what `--order recent` sorts on, and it comes from the chat, not the contact.
   */
  lastMessagedAt: string | null
}

/** Somebody in a chat, as much of them as a chat card shows. */
export type Member = Pick<Contact, "id" | "name" | "username">

/** A topic of a forum group; its messages carry this id as `threadId`. */
export interface Topic {
  id: Id
  title: string
  closed: boolean
  pinned: boolean
  unreadCount: number | null
  /** ISO 8601. */
  lastMessageAt: string | null
  createdAt: string | null
}

/** What a link leads to, read without joining. */
export interface LinkTarget {
  kind: ChatKind
  title: string | null
  /** `null` for a private chat the owner is not in: the invite does not say. */
  id: Id | null
  username: string | null
  participantsCount: number | null
  description: string | null
  /** Whether the owner is already in it; `null` where the messenger does not say. */
  member: boolean | null
  /** Joining waits for an admin's approval. */
  approvalNeeded?: boolean
}

/** Somewhere this account is logged in — a device, a browser, this tool. */
export interface AccountSession {
  /** The session this tool is using. */
  current: boolean
  /** The app and its version, as the messenger names it. */
  client: string | null
  /** The device and its system. */
  device: string | null
  location: string | null
  /** ISO 8601. */
  lastActiveAt: string | null
  createdAt?: string | null
}

/** Someone in a group as `chats members list` answers them. */
export interface GroupMember extends Member {
  /** Absent where the messenger does not say who runs the group. */
  role?: "owner" | "admin" | "member"
  /** ISO 8601, when they were last seen; `null` when their privacy hides it, absent where the messenger does not say. */
  lastSeenAt?: string | null
}

/** One chat and who is in it. `members` is `null` where nobody recorded that — a channel, always. */
export interface ChatCard extends Chat {
  members: Member[] | null
}

/** One person and the chats this account shares with them, newest first. */
export interface PersonCard extends Contact {
  chats: Pick<Chat, "id" | "title" | "kind" | "lastMessageAt">[]
}

/**
 * One page of a listing, and **the same shape whether it came from the provider or from the
 * store** — where rows come from is the exit code's business and the diagnostics', never the
 * answer's. `hasMore` rather than a total: counting rows nobody has fetched is a second cost.
 */
export interface Page<T> {
  items: T[]
  hasMore: boolean
}

/** Who a profile is logged in as. */
export interface Account {
  id: Id
  name: string | null
  /** The public handle, without `@`, when there is one. */
  username: string | null
  /** The whole number, where the messenger tells it; printed as its last four digits unless asked. */
  phone?: string | null
}

export interface Profile {
  id: Id
  name: string | null
  phone: string | null
  description: string | null
}

/** One message of a window around another, which carries `anchor: true`. */
export type WindowedMessage = Message & { anchor?: true }
