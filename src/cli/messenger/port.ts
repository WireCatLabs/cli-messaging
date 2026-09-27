import type { Account, Chat, ChatCard, Id, Message, Page, PersonCard, WindowedMessage } from "../../domain/models.js"

export interface Sent {
  message: Message
  /** The send's identity. Repeat it after an unknown outcome, never a new one. */
  sendId: string
}

/**
 * What a messenger does for the shared commands. Each CLI implements it over its own library, and
 * nothing of that library's shape crosses it. A chat is passed as typed — a title, an id, a handle —
 * because only the adapter knows how its messenger finds one.
 */
export interface MessengerAdapter {
  /** The logged-in account's id, from what is stored locally — no request. `null` before a login. */
  self(): Id | null
  me(): Promise<Account>
  chats(window: { limit?: number; offset: number }): Promise<Page<Chat>>
  /** Oldest to newest. `before` is a message id, or whatever the messenger pages by, as typed. */
  history(chat: string, window: { limit: number; before?: string }): Promise<Page<Message>>
  resolve(chat: string): Promise<Chat>
  /** One chat and who is in it; `members` is `null` where the messenger does not say — a channel, a hidden list. */
  chat(chat: string): Promise<ChatCard>
  /** One person and the chats this account shares with them, newest first. A chat that is not a person is refused. */
  contact(person: string): Promise<PersonCard>
  /** One message and up to `before` and `after` either side, oldest first; the one asked for carries `anchor`. */
  around(chat: string, messageId: Id, window: { before: number; after: number }): Promise<WindowedMessage[]>
  /** `replyTo` is a message id in the same chat. */
  send(chatId: Id, text: string, options: { sendId: string; replyTo?: Id }): Promise<Sent>
  logout(): Promise<void>
  close(): Promise<void>
}
