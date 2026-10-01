import { CliError } from "@leemour/cli-core"
import { type LinkInput, linkMessages, RULES_VERSION } from "../conversations/link.js"
import type { Id, Message, Page } from "../domain/models.js"
import type { ConversationSummary, StoredLink } from "../store/store.js"
import type { ServiceDeps } from "./deps.js"
import { storedChatId } from "./messages.js"

/** A page of messages handed to the rules at a time; reading is quick, the rules hold a 50-message window. */
const READ_PAGE = 5_000

/** How far `links` follows a message's chosen parents back. */
const CHAIN = 50

export interface Built {
  chat: Id
  messages: number
  links: number
  conversations: number
  builtAt: string
  rulesVersion: number
}

export interface MessageLinks {
  chat: Id
  message: Id
  /** The message's own links; `chosen` is the one its conversation follows. */
  links: (StoredLink & { chosen: boolean })[]
  /** Its chosen parents back to where the conversation starts, nearest first. */
  chain: Id[]
}

/**
 * Conversations inside a chat, built from the store alone by rules (phase 3): replies, mentions and one
 * sender's messages in a row. Nothing is built on sync; a chat has conversations once `build` ran for it.
 */
export interface ConversationsService {
  build(chat: string): Promise<Built>
  list(chat: string, window: { limit: number; since?: string }): Promise<Page<ConversationSummary>>
  /** By the conversation's id, or as the conversation a message is in. */
  show(
    target: { id: string } | { chat: string; message: Id },
  ): Promise<{ summary: ConversationSummary; messages: Message[] }>
  links(chat: string, message: Id): Promise<MessageLinks>
}

export const conversationsService = (deps: ServiceDeps): ConversationsService => {
  const found = async (chat: string) => {
    const store = await deps.store()
    const account = await deps.account()
    return { store, account, chatId: await storedChatId(deps.messenger, chat, store, account) }
  }

  const notBuilt = (chatId: Id) =>
    new CliError(
      "not_found",
      `chat ${chatId} has no conversations yet — \`${deps.messenger.app.command} conversations build --chat ${chatId}\``,
    )

  return {
    build: async (chat) => {
      const { store, account, chatId } = await found(chat)
      const startedAt = Date.now()
      const inputs: LinkInput[] = []
      let after: string | undefined
      for (;;) {
        const page = await store.linkInputs(account, chatId, { limit: READ_PAGE, ...(after ? { after } : {}) })
        inputs.push(...page.items)
        if (page.next === null) break
        after = page.next
      }
      if (inputs.length === 0) {
        throw new CliError("not_found", `the store holds no messages of chat ${chatId} — fetch them first`)
      }
      const { links, conversations } = linkMessages(inputs, { handles: await store.senderHandles(account, chatId) })
      await store.replaceConversations(account, chatId, {
        startedAt,
        algorithmVersion: RULES_VERSION,
        links,
        conversations,
      })
      return {
        chat: chatId,
        messages: inputs.length,
        links: links.length,
        conversations: conversations.length,
        builtAt: new Date(startedAt).toISOString(),
        rulesVersion: RULES_VERSION,
      }
    },

    list: async (chat, { limit, since }) => {
      const { store, account, chatId } = await found(chat)
      if (!(await store.conversationState(account, chatId))?.builtAt) throw notBuilt(chatId)
      return store.conversations(account, chatId, { limit, ...(since === undefined ? {} : { after: since }) })
    },

    show: async (target) => {
      const store = await deps.store()
      const account = await deps.account()
      let id: string
      if ("id" in target) {
        id = target.id
      } else {
        const { chatId } = await found(target.chat)
        const of = await store.conversationOf(account, chatId, target.message)
        if (of === undefined) {
          if (!(await store.conversationState(account, chatId))?.builtAt) throw notBuilt(chatId)
          throw new CliError("not_found", `message ${target.message} is in no conversation of chat ${chatId}`)
        }
        id = of
      }
      const conversation = await store.conversation(account, id)
      if (!conversation) {
        throw new CliError("not_found", `no conversation ${id} — a rebuild gives new ids; \`conversations list\``)
      }
      return conversation
    },

    links: async (chat, message) => {
      const { store, account, chatId } = await found(chat)
      const chosenOf = (links: StoredLink[]) => links.find((link) => !link.stale)
      const own = await store.links(account, chatId, message)
      const chosen = chosenOf(own)
      const chain: Id[] = []
      for (let parent = chosen?.parentId ?? null; parent !== null && chain.length < CHAIN; ) {
        if (chain.includes(parent)) break
        chain.push(parent)
        parent = chosenOf(await store.links(account, chatId, parent))?.parentId ?? null
      }
      return { chat: chatId, message, links: own.map((link) => ({ ...link, chosen: link === chosen })), chain }
    },
  }
}
