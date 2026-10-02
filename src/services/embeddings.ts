import { CliError } from "@leemour/cli-core"
import { CHUNK_CHARS, chunkHash, chunkTextOf } from "../conversations/chunks.js"
import type { Id } from "../domain/models.js"
import { type Embedder, isTextModelInstalled, textModelsDirectory } from "../embeddings/embed.js"
import { DEFAULT_TEXT_MODEL, type TextModel, textModel } from "../embeddings/models.js"
import { type RemoteModel, remoteKey } from "../embeddings/remote.js"
import type { ConversationHit } from "../store/store.js"
import type { ServiceDeps } from "./deps.js"
import { storedChatId } from "./messages.js"

/** A local model by id (the default when nothing is given), or a remote one with the user's key (E11). */
export type ModelChoice = string | { remote: RemoteModel; apiKey?: string; concurrency?: number }

export interface EmbedStatus {
  chat: Id
  model: string
  /** The current build's distinct chunk texts. */
  chunks: number
  embedded: number
  left: number
  /** A local model at its measured speed on one session; `null` for a remote one. */
  estimateSeconds: number | null
  /** At most this many tokens are sent for what is left — a chunk is at most `CHUNK_CHARS` characters. */
  tokensAtMost: number
  /** For a remote model with a known price: at most this many US dollars for what is left. */
  priceAtMost?: { usd: number; read: string }
}

export interface Embedded {
  chat: Id
  model: string
  embedded: number
  /** Chunks whose messages changed since the build: `conversations build` cuts them again. */
  skipped: number
}

export interface EmbeddingsService {
  status(chat: string, model?: ModelChoice): Promise<EmbedStatus>
  /** Embeds every chunk of the chat's current build that has no vector of the model, a batch at a time. */
  embed(
    chat: string,
    options: {
      model?: ModelChoice
      workers?: number
      threads?: number
      progress?: (done: number, left: number) => void
    },
  ): Promise<Embedded>
  /** Drops the chat's vectors, or one model's; messages and conversations are never touched. */
  clear(chat: string, model?: ModelChoice): Promise<{ chat: Id; cleared: number }>
  /** The conversations nearest in meaning to `query`, in one chat or every one of the account (E7). */
  search(
    query: string,
    options: { chat?: string; model?: ModelChoice; since?: string; limit: number },
  ): Promise<{ model: string; hits: ConversationHit[]; embeddedOnlyElsewhere: Id[] }>
}

/** A vector's model: the provider, the model and its size — vectors of two of them never mix. */
export const vectorModelKey = (model: TextModel): string => `local:${model.id}:${model.dims}`

/** Chunks per batch for one local session; one short transaction writes each batch. */
const PER_SESSION = 8
/** Texts per remote request; `concurrency` of them run at once. */
const PER_REQUEST = 256
/** e5's tokenizer reads ~3.7 characters a token in Russian; 3 keeps the bound above the real count. */
const CHARS_PER_TOKEN_AT_LEAST = 3

export const embeddingsService = (deps: ServiceDeps): EmbeddingsService => {
  const command = deps.messenger.app.command

  const resolve = (choice: ModelChoice = DEFAULT_TEXT_MODEL) => {
    if (typeof choice !== "string") {
      const { remote, apiKey, concurrency = 4 } = choice
      return {
        id: `${remote.provider}:${remote.model}`,
        key: remoteKey(remote),
        dims: remote.dims,
        speed: null,
        price: remote.price,
        perBatch: (_workers: number) => PER_REQUEST * concurrency,
        open: async (): Promise<Embedder> =>
          (await import("../embeddings/remote.js")).openRemote(remote, apiKey, { concurrency }),
      }
    }
    const model = textModel(choice)
    const directory = textModelsDirectory(deps.env)
    return {
      id: model.id,
      key: vectorModelKey(model),
      dims: model.dims,
      speed: model.chunksPerSecond,
      price: undefined,
      perBatch: (workers: number) => PER_SESSION * Math.max(1, workers),
      open: async ({ workers = 1, threads }: { workers?: number; threads?: number } = {}): Promise<Embedder> => {
        if (!isTextModelInstalled(model, directory)) {
          throw new CliError(
            "not_found",
            `${model.id} is not downloaded — \`${command} models text download ${model.id}\``,
          )
        }
        const { openPool } = await import("../embeddings/pool.js")
        return openPool(model, directory, { workers, ...(threads ? { threads } : {}) })
      },
    }
  }

  const found = async (chat: string) => {
    const store = await deps.store()
    const account = await deps.account()
    const chatId = await storedChatId(deps.messenger, chat, store, account)
    if (!(await store.conversationState(account, chatId))?.builtAt) {
      throw new CliError(
        "not_found",
        `chat ${chatId} has no conversations yet — \`${command} conversations build --chat ${chatId}\``,
      )
    }
    return { store, account, chatId }
  }

  return {
    status: async (chat, choice) => {
      const { store, account, chatId } = await found(chat)
      const target = resolve(choice)
      const { chunks, embedded } = await store.vectorStatus(account, chatId, target.key)
      const left = chunks - embedded
      const tokensAtMost = Math.ceil((left * CHUNK_CHARS) / CHARS_PER_TOKEN_AT_LEAST)
      return {
        chat: chatId,
        model: target.id,
        chunks,
        embedded,
        left,
        estimateSeconds: target.speed === null ? null : Math.ceil(left / target.speed),
        tokensAtMost,
        ...(target.price
          ? { priceAtMost: { usd: (tokensAtMost / 1e6) * target.price.perMillion, read: target.price.read } }
          : {}),
      }
    },

    embed: async (chat, { model: choice, workers = 1, threads, progress }) => {
      const { store, account, chatId } = await found(chat)
      const target = resolve(choice)
      const embedder = await target.open({ workers, ...(threads ? { threads } : {}) })
      let embedded = 0
      let skipped = 0
      try {
        let left = (await store.vectorStatus(account, chatId, target.key)).chunks
        let after: string | undefined
        for (;;) {
          const batch = await store.chunksToEmbed(account, chatId, target.key, {
            limit: target.perBatch(workers),
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
            target.key,
            target.dims,
            ready.map(({ hash }, index) => ({ hash, vector: vectors[index] as Float32Array })),
          )
          embedded += ready.length
          left = Math.max(0, left - batch.length)
          progress?.(embedded, left)
        }
      } finally {
        await embedder.close()
      }
      return { chat: chatId, model: target.id, embedded, skipped }
    },

    search: async (query, { chat, model: choice, since, limit }) => {
      const store = await deps.store()
      const account = await deps.account()
      const target = resolve(choice)
      const chatId = chat === undefined ? undefined : await storedChatId(deps.messenger, chat, store, account)
      const warm = typeof choice !== "object" ? deps.embedders : undefined
      const embedder = warm ? await warm.get(target.key, () => target.open()) : await target.open()
      try {
        const [vector] = await embedder.embed([query], "query")
        const scope = chatId === undefined ? {} : { chatId }
        const hits = await store.nearestConversations(account, {
          ...scope,
          ...(since === undefined ? {} : { since }),
          model: target.key,
          limit,
          query: vector as Float32Array,
        })
        const elsewhere = await store.embeddedOnlyElsewhere(account, { ...scope, model: target.key })
        return { model: target.id, hits, embeddedOnlyElsewhere: elsewhere }
      } finally {
        if (!warm) await embedder.close()
      }
    },

    clear: async (chat, choice) => {
      const store = await deps.store()
      const account = await deps.account()
      const chatId = await storedChatId(deps.messenger, chat, store, account)
      const cleared = await store.clearVectors(account, chatId, choice === undefined ? undefined : resolve(choice).key)
      return { chat: chatId, cleared }
    },
  }
}
