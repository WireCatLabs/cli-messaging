import { type ChatsService, chatsService } from "./chats.js"
import type { ServiceDeps } from "./deps.js"
import { type MessagesService, messagesService } from "./messages.js"
import { type PeopleService, peopleService } from "./people.js"

export type { ChatFilter, ChatsService, MarkedRead, PageWindow } from "./chats.js"
export { CHAT_SCAN, chatsService, EVENTS_DAYS } from "./chats.js"
export type { ServiceDeps } from "./deps.js"
export { OFFLINE, onlineDeps, storedDeps } from "./deps.js"
export type {
  AroundWindow,
  ListWindow,
  MessagesService,
  MessageTarget,
  Pinned,
  Reacted,
  SearchQuery,
  SendRequest,
} from "./messages.js"
export { DELETE_AT_ONCE, messagesService, storedChatId } from "./messages.js"
export type { ContactSync, PeopleService } from "./people.js"
export { peopleService, phoneOf } from "./people.js"

export interface Services {
  messages: MessagesService
  chats: ChatsService
  people: PeopleService
}

export const servicesFor = (deps: ServiceDeps): Services => ({
  messages: messagesService(deps),
  chats: chatsService(deps),
  people: peopleService(deps),
})
