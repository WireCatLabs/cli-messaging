import { CliError } from "@leemour/cli-core"
import { chunkHash, chunkTextOf } from "../conversations/chunks.js"
import type { Id } from "../domain/models.js"
import { isTextModelInstalled, textModelsDirectory } from "../embeddings/embed.js"
import { DEFAULT_TEXT_MODEL, type TextModel, textModel } from "../embeddings/models.js"
import type { ConversationHit } from "../store/store.js"
import type { ServiceDeps } from "./deps.js"
import { storedChatId } from "./messages.js"

export interface EmbedStatus {
  chat: Id
  model: string
  /** The current build's distinct chunk texts. */
  chunks: number
  embedded: number
  left: number
  /** At the model's measured speed on one session; workers shorten it. */
  estimateSeconds: number
}

export interface Embedded {
  chat: Id
  model: string
  embedded: number
  /** Chunks whose messages changed since the build: `conversations build` cuts them again. */
  skipped: number
}

export interface EmbeddingsService {
  status(chat: string, model?: string): Promise<EmbedStatus>
  /** Embeds every chunk of the chat's current build that has no vector of the model, a batch at a time. */
  embed(
    chat: string,
    options: { model?: string; workers?: number; threads?: number; progress?: (done: number, left: number) => void },
  ): Promise<Embedded>
  /** Drops the chat's vectors, or one model's; messages and conversations are never touched. */
  clear(chat: string, model?: string): Promise<{ chat: Id; cleared: number }>
  /** The conversations nearest in meaning to `query`, in one chat or every one of the account (E7). */
  search(
    query: string,
    options: { chat?: string; model?: string; since?: string; limit: number },
  ): Promise<{ model: string; hits: ConversationHit[] }>
}

/** A vector's model: the provider, the model and its size — vectors of two of them never mix. */
export const vectorModelKey = (model: TextModel): string => `local:${model.id}:${model.dims}`

/** Chunks per batch for one session; one short transaction writes each batch. */
const PER_SESSION = 8

export const embeddingsService = (deps: ServiceDeps): EmbeddingsService => {
  const found = async (chat: string, id = DEFAULT_TEXT_MODEL) => {
    const store = await deps.store()
    const account = await deps.account()
    const chatId = await storedChatId(deps.messenger, chat, store, account)
    const command = deps.messenger.app.command
    if (!(await store.conversationState(account, chatId))?.builtAt) {
      throw new CliError(
        "not_found",
        `chat ${chatId} has no conversations yet — \`${command} conversations build --chat ${chatId}\``,
      )
    }
    const model = textModel(id)
    return { store, account, chatId, model, key: vectorModelKey(model), command }
  }

  return {
    status: async (chat, id) => {
      const { store, account, chatId, model, key } = await found(chat, id)
      const { chunks, embedded } = await store.vectorStatus(account, chatId, key)
      return {
        chat: chatId,
        model: model.id,
        chunks,
        embedded,
        left: chunks - embedded,
        estimateSeconds: Math.ceil((chunks - embedded) / model.chunksPerSecond),
      }
    },

    embed: async (chat, { model: id, workers = 1, threads, progress }) => {
      const { store, account, chatId, model, key, command } = await found(chat, id)
      const directory = textModelsDirectory(deps.env)
      if (!isTextModelInstalled(model, directory)) {
        throw new CliError(
          "not_found",
          `${model.id} is not downloaded — \`${command} models text download ${model.id}\``,
        )
      }
      const { openPool } = await import("../embeddings/pool.js")
      const embedder = await openPool(model, directory, { workers, ...(threads ? { threads } : {}) })
      let embedded = 0
      let skipped = 0
      try {
        let left = (await store.vectorStatus(account, chatId, key)).chunks
        let after: string | undefined
        for (;;) {
          const batch = await store.chunksToEmbed(account, chatId, key, {
            limit: PER_SESSION * Math.max(1, workers),
            ...(after ? { after } : {}),
          })
          if (batch.length === 0) break
          after = batch.at(-1)?.hash
          const ready = batch.flatMap(({ hash, lines }) => {
            const text = chunkTextOf(lines)
            return chunkHash(text) === hash ? [{ hash, text }] : []
          })
          skipped += batch.length - ready.length
          const vectors = await embedder.embed(
            ready.map(({ text }) => text),
            "passage",
          )
          await store.saveVectors(
            key,
            model.dims,
            ready.map(({ hash }, index) => ({ hash, vector: vectors[index] as Float32Array })),
          )
          embedded += ready.length
          left = Math.max(0, left - batch.length)
          progress?.(embedded, left)
        }
      } finally {
        await embedder.close()
      }
      return { chat: chatId, model: model.id, embedded, skipped }
    },

    search: async (query, { chat, model: id = DEFAULT_TEXT_MODEL, since, limit }) => {
      const store = await deps.store()
      const account = await deps.account()
      const model = textModel(id)
      const command = deps.messenger.app.command
      const chatId = chat === undefined ? undefined : await storedChatId(deps.messenger, chat, store, account)
      const directory = textModelsDirectory(deps.env)
      if (!isTextModelInstalled(model, directory)) {
        throw new CliError(
          "not_found",
          `${model.id} is not downloaded — \`${command} models text download ${model.id}\``,
        )
      }
      const { openEmbedder } = await import("../embeddings/embed.js")
      const embedder = await openEmbedder(model, directory)
      try {
        const [vector] = await embedder.embed([query], "query")
        const hits = await store.nearestConversations(account, {
          ...(chatId === undefined ? {} : { chatId }),
          ...(since === undefined ? {} : { since }),
          model: vectorModelKey(model),
          limit,
          query: vector as Float32Array,
        })
        return { model: model.id, hits }
      } finally {
        await embedder.close()
      }
    },

    clear: async (chat, id) => {
      const store = await deps.store()
      const account = await deps.account()
      const chatId = await storedChatId(deps.messenger, chat, store, account)
      const cleared = await store.clearVectors(
        account,
        chatId,
        id === undefined ? undefined : vectorModelKey(textModel(id)),
      )
      return { chat: chatId, cleared }
    },
  }
}
