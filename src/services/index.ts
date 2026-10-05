import { type AccountService, accountService } from "./account.js"
import { type AdminService, adminService } from "./admin.js"
import { type ArchiveService, archiveService } from "./archive.js"
import { type AttachmentsService, attachmentsService } from "./attachments.js"
import { type ChatsService, chatsService } from "./chats.js"
import { type ConversationsService, conversationsService } from "./conversations.js"
import type { ServiceDeps } from "./deps.js"
import { type EmbeddingsService, embeddingsService } from "./embeddings.js"
import { type FoldersService, foldersService } from "./folders.js"
import { type InboxService, inboxService } from "./inbox.js"
import { type MessagesService, messagesService } from "./messages.js"
import { type ModerationService, moderationService } from "./moderation.js"
import { type PeopleService, peopleService } from "./people.js"
import { type SearchesService, searchesService } from "./searches.js"
import { type TagsService, tagsService } from "./tags.js"
import { type TopicsService, topicsService } from "./topics.js"

export type { AccountService } from "./account.js"
export { accountService } from "./account.js"
export type { AdminService, NewGroup } from "./admin.js"
export { adminService } from "./admin.js"
export type { ArchiveService, Fetched, FetchOptions } from "./archive.js"
export { archiveService } from "./archive.js"
export type {
  AttachmentsService,
  ExtractItem,
  ExtractOptions,
  ExtractRun,
  ExtractStatus,
} from "./attachments.js"
export { attachmentsService } from "./attachments.js"
export type { ChatFilter, ChatsService, MarkedRead, PageWindow } from "./chats.js"
export { CHAT_SCAN, chatsService, EVENTS_DAYS } from "./chats.js"
export type { BatchStatus, Built, ConversationsService, MessageLinks } from "./conversations.js"
export { BATCH_SIZE, conversationsService } from "./conversations.js"
export type { ServiceDeps } from "./deps.js"
export { OFFLINE, onlineDeps, storedDeps } from "./deps.js"
export type { Embedded, EmbeddingsService, EmbedStatus, FoundConversation } from "./embeddings.js"
export { embeddingsService } from "./embeddings.js"
export type { EvidenceKind, EvidenceMessage, EvidencePacket, EvidencePacketInput, EvidenceSource } from "./evidence.js"
export { prepareEvidencePacket } from "./evidence.js"
export type { EvidenceReadQuery, StoredEvidencePacket } from "./evidence-read.js"
export { readEvidencePacket } from "./evidence-read.js"
export type { FolderEdit, FoldersService } from "./folders.js"
export { foldersService } from "./folders.js"
export type { InboxService } from "./inbox.js"
export { inboxService } from "./inbox.js"
export type {
  AroundWindow,
  FoundMessage,
  ListWindow,
  MessagesService,
  MessageTarget,
  Pinned,
  Reacted,
  SearchFound,
  SearchQuery,
  SendRequest,
} from "./messages.js"
export { DELETE_AT_ONCE, messagesService, searchStore, storedChatId } from "./messages.js"
export type { ModerateOptions, ModerationService, ShownRules } from "./moderation.js"
export { moderationService } from "./moderation.js"
export type { ContactSync, PeopleService } from "./people.js"
export { peopleService, phoneOf } from "./people.js"
export type { ResolvedSearch, SearchesService, SearchParams } from "./searches.js"
export { searchesService, searchRecordOf } from "./searches.js"
export type { TagsAdded, TagsRemoved, TagsService, TagTargetInput, TagTargetView } from "./tags.js"
export { tagsService } from "./tags.js"
export { type TopicsService, topicsService } from "./topics.js"

export interface Services {
  topics: TopicsService
  messages: MessagesService
  chats: ChatsService
  people: PeopleService
  inbox: InboxService
  archive: ArchiveService
  admin: AdminService
  folders: FoldersService
  account: AccountService
  moderation: ModerationService
  conversations: ConversationsService
  embeddings: EmbeddingsService
  tags: TagsService
  searches: SearchesService
  attachments: AttachmentsService
}

/**
 * How a CLI replaces a use case: it returns the services it changes, whole, and can call the shared
 * method inside its own — `messages: { ...base.messages, list: (chat, window) => … base.messages.list … }`.
 */
export type Override = (base: Services, deps: ServiceDeps) => Partial<Services>

/** The shared services, with the messenger's `services` override applied — commands and MCP tools alike. */
export const servicesFor = (deps: ServiceDeps): Services => {
  const base: Services = {
    topics: topicsService(deps),
    messages: messagesService(deps),
    chats: chatsService(deps),
    people: peopleService(deps),
    inbox: inboxService(deps),
    archive: archiveService(deps),
    admin: adminService(deps),
    folders: foldersService(deps),
    account: accountService(deps),
    moderation: moderationService(deps),
    conversations: conversationsService(deps),
    embeddings: embeddingsService(deps),
    tags: tagsService(deps),
    attachments: attachmentsService(deps),
    searches: searchesService(deps),
  }
  return deps.messenger.services ? { ...base, ...deps.messenger.services(base, deps) } : base
}

export { migrateLegacyQuery, type QueryMigration, type SavedQuery } from "../search/lucene/migration.js"
export { parseLucene } from "../search/lucene/parser.js"
export { FIELD_VERSION, QUERY_FIELDS, QUERY_OPERATORS, validateAst } from "../search/lucene/registry.js"
export { type Predicate, QUERY_LIMITS, QUERY_VERSION, type QueryAst, type QueryNode } from "../search/lucene/types.js"
export type { QueryMetadata, SearchCoverage } from "./messages-search.js"

export {
  type PackageUpgradeOutcome,
  type PackageUpgradePorts,
  type PackageUpgradeResult,
  type ServerRestarts,
  upgradePackage,
} from "./package-upgrade.js"
