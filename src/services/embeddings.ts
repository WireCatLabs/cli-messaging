import { CliError } from "@leemour/cli-core"
import { chunkHash, chunkTextOf } from "../conversations/chunks.js"
import type { Id } from "../domain/models.js"
import { isTextModelInstalled, textModelsDirectory } from "../embeddings/embed.js"
import { DEFAULT_TEXT_MODEL, type TextModel, textModel } from "../embeddings/models.js"
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
