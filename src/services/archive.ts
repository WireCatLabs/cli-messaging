import { setTimeout as sleep } from "node:timers/promises"
import { CliError } from "@leemour/cli-core"
import { type Estimate, estimateBackfill } from "../cli/messenger/backfill-estimate.js"
import { patiently } from "../cli/messenger/patience.js"
import type { Id, Message } from "../domain/models.js"
import type { ChatStats, Range } from "../store/store.js"
import type { ServiceDeps } from "./deps.js"
import { storedChatId } from "./messages.js"

/** The most messages a provider hands out per history request — Telegram's cap. */
const PAGE = 100

export interface FetchOptions {
  max: number
  pauseMs: number
  /** Stop after the page that reaches a message older than this, epoch milliseconds. */
  sinceMs?: number
  note: (message: string) => void
  stop: AbortSignal
  onPage: (progress: { fetched: number; chatId: string; oldest: number }) => void
}

/** A type, not an interface: a job keeps it as a plain record. */
export type Fetched = {
  chat: Id | null
  fetched: number
  complete: boolean
  ranges: Range[]
  reachedSince?: true
  stopped?: true
}

/** The local store of messages: what it holds, filling it from the messenger, and reading it out. */
export interface ArchiveService {
  /** Per chat, or for one: what is stored, and the stretches held completely. From the store alone. */
  status(chat?: string): Promise<(ChatStats & { held: Range[] })[]>
  /** The stretches held of a chat already found by id. */
  held(chatId: Id): Promise<Range[]>
  /** One chat's stored messages, oldest first, and its title. */
  export(chat: string): Promise<{ title: string; messages: Message[] }>
  /** What a full fetch would still cost, from the store alone. */
  estimate(chat: string, options: { max: number; pauseMs: number }): Promise<Estimate & { chat: Id }>
  /**
   * A chat's history into the store, newest to oldest, **resumable**: after every page the stretch
   * it covered is recorded, so a stop loses nothing and the next run jumps over what is held. Needs
   * numeric message ids, which order the chat.
   */
  fetch(chat: string, options: FetchOptions): Promise<Fetched>
}

export const archiveService = (deps: ServiceDeps): ArchiveService => {
  const found = async (chat: string) => {
    const store = await deps.store()
    const account = await deps.account()
    return { store, account, chatId: await storedChatId(deps.messenger, chat, store, account) }
  }

  return {
    status: async (chat) => {
      const store = await deps.store()
      const account = await deps.account()
      const only = chat === undefined ? undefined : await storedChatId(deps.messenger, chat, store, account)
      const stats = await store.chatStats(account, only)
      return Promise.all(stats.map(async (one) => ({ ...one, held: await store.ranges(account, one.chatId) })))
    },

    held: async (chatId) => (await deps.store()).ranges(await deps.account(), chatId),

    export: async (chat) => {
      const { store, account, chatId } = await found(chat)
      return {
        title: (await store.chatStats(account, chatId))[0]?.title ?? chatId,
        messages: (await store.messages(account, chatId, { limit: Number.MAX_SAFE_INTEGER })).items,
      }
    },

    estimate: async (chat, { max, pauseMs }) => {
      const { store, account, chatId } = await found(chat)
      const newest = Number((await store.messages(account, chatId, { limit: 1 })).items[0]?.id)
      return {
        chat: chatId,
        ...estimateBackfill({
          ranges: await store.ranges(account, chatId),
          held: (await store.chatStats(account, chatId))[0]?.messages ?? 0,
          newest: Number.isSafeInteger(newest) ? newest : undefined,
          page: PAGE,
          max,
          pauseMs,
        }),
      }
    },

    fetch: async (chat, { max, pauseMs, sinceMs, note, stop, onPage }) => {
      const connection = await deps.connection()
      const self = connection.self()
      if (self === null) throw new CliError("authentication_error", "not logged in — nothing to fetch for")
      const account = { provider: deps.messenger.provider, account: self }
      const store = await deps.store()
      let before: string | undefined
      let chatId: Id | undefined
      let top: number | undefined
      let fetched = 0
      let reachedStart = false
      let reachedSince = false

      while (fetched < max && !stop.aborted) {
        const page = await patiently(
          () => connection.history(chat, { limit: PAGE, ...(before ? { before } : {}) }),
          note,
          stop,
        )
        const first = page.items[0]
        if (!first) {
          reachedStart = true
          break
        }
        chatId ??= first.chatId
        const keys = page.items.map((message) => Number(message.id))
        if (keys.some((key) => !Number.isSafeInteger(key))) {
          throw new CliError(
            "validation_error",
            "this messenger's message ids do not order a chat, so it cannot fetch its history",
          )
        }
        const low = Math.min(...keys)
        top ??= Math.max(...keys)
        fetched += page.items.length
        // This run's pages are contiguous, so everything from `low` to its first message is held.
        const held = await store.markRange(account, chatId, low, top)
        onPage({ fetched, chatId, oldest: held.from })
        if (!page.hasMore) {
          reachedStart = true
          break
        }
        if (sinceMs !== undefined && page.items.some((message) => Date.parse(message.timestamp) < sinceMs)) {
          reachedSince = true
          break
        }
        before = String(held.from)
        note(`${fetched} messages so far, back to ${held.from}`)
        await sleep(pauseMs, undefined, { signal: stop }).catch(() => {})
      }

      const ranges = chatId === undefined ? [] : await store.ranges(account, chatId)
      return {
        chat: chatId ?? null,
        fetched,
        complete: reachedStart && ranges.length === 1,
        ranges,
        ...(reachedSince ? { reachedSince: true as const } : {}),
        ...(stop.aborted ? { stopped: true as const } : {}),
      }
    },
  }
}
