import type { ServiceDeps } from "./deps.js"
import { type MessagesService, messagesService } from "./messages.js"

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

export interface Services {
  messages: MessagesService
}

export const servicesFor = (deps: ServiceDeps): Services => ({ messages: messagesService(deps) })
