import { type AccountService, accountService } from "./account.js"
import { type AdminService, adminService } from "./admin.js"
import { type ArchiveService, archiveService } from "./archive.js"
import { type ChatsService, chatsService } from "./chats.js"
import type { ServiceDeps } from "./deps.js"
import { type FoldersService, foldersService } from "./folders.js"
import { type InboxService, inboxService } from "./inbox.js"
import { type MessagesService, messagesService } from "./messages.js"
import { type ModerationService, moderationService } from "./moderation.js"
import { type PeopleService, peopleService } from "./people.js"

export type { AccountService } from "./account.js"
export { accountService } from "./account.js"
export type { AdminService, NewGroup } from "./admin.js"
export { adminService } from "./admin.js"
export type { ArchiveService, Fetched, FetchOptions } from "./archive.js"
export { archiveService } from "./archive.js"
export type { ChatFilter, ChatsService, MarkedRead, PageWindow } from "./chats.js"
export { CHAT_SCAN, chatsService, EVENTS_DAYS } from "./chats.js"
export type { ServiceDeps } from "./deps.js"
export { OFFLINE, onlineDeps, storedDeps } from "./deps.js"
export type { FolderEdit, FoldersService } from "./folders.js"
export { foldersService } from "./folders.js"
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
export type { ModerateOptions, ModerationService, ShownRules } from "./moderation.js"
export { moderationService } from "./moderation.js"
export type { ContactSync, PeopleService } from "./people.js"
export { peopleService, phoneOf } from "./people.js"

export interface Services {
  messages: MessagesService
  chats: ChatsService
  people: PeopleService
  inbox: InboxService
  archive: ArchiveService
  admin: AdminService
  folders: FoldersService
  account: AccountService
  moderation: ModerationService
}

/**
 * How a CLI replaces a use case: it returns the services it changes, whole, and can call the shared
 * method inside its own — `messages: { ...base.messages, list: (chat, window) => … base.messages.list … }`.
 */
export type Override = (base: Services, deps: ServiceDeps) => Partial<Services>

/** The shared services, with the messenger's `services` override applied — commands and MCP tools alike. */
export const servicesFor = (deps: ServiceDeps): Services => {
  const base: Services = {
    messages: messagesService(deps),
    chats: chatsService(deps),
    people: peopleService(deps),
    inbox: inboxService(deps),
    archive: archiveService(deps),
    admin: adminService(deps),
    folders: foldersService(deps),
    account: accountService(deps),
    moderation: moderationService(deps),
  }
  return deps.messenger.services ? { ...base, ...deps.messenger.services(base, deps) } : base
}
