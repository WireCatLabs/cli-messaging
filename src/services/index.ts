import { type ArchiveService, archiveService } from "./archive.js"
import { type ChatsService, chatsService } from "./chats.js"
import type { ServiceDeps } from "./deps.js"
import { type InboxService, inboxService } from "./inbox.js"
import { type MessagesService, messagesService } from "./messages.js"
import { type PeopleService, peopleService } from "./people.js"

export type { ArchiveService, Fetched, FetchOptions } from "./archive.js"
export { archiveService } from "./archive.js"
export type { ChatFilter, ChatsService, MarkedRead, PageWindow } from "./chats.js"
export { CHAT_SCAN, chatsService, EVENTS_DAYS } from "./chats.js"
export type { ServiceDeps } from "./deps.js"
export { OFFLINE, onlineDeps, storedDeps } from "./deps.js"
export type { InboxService } from "./inbox.js"
export { inboxService } from "./inbox.js"
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
  inbox: InboxService
  archive: ArchiveService
}

export const servicesFor = (deps: ServiceDeps): Services => ({
  messages: messagesService(deps),
  chats: chatsService(deps),
  people: peopleService(deps),
  inbox: inboxService(deps),
  archive: archiveService(deps),
})
