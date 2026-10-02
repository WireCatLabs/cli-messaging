import { readFileSync } from "node:fs"
import { availableParallelism } from "node:os"
import { basename, join } from "node:path"
import { filesPresent, sharedModelsDirectory } from "../speech/install.js"
import type { TextModel } from "./models.js"

export const textModelsDirectory = (env: NodeJS.ProcessEnv = process.env): string => sharedModelsDirectory("text", env)

export const placedText = (model: TextModel, directory: string) =>
  model.files.map((file) => [file, join(directory, model.id, file.name)] as [typeof file, string])

export const isTextModelInstalled = (model: TextModel, directory: string): boolean =>
  filesPresent(placedText(model, directory))

/** Past 8 threads one session gains nothing; Bun takes 1 unless told (`2026-10-02-embeddings.md`). */
export const defaultThreads = (): number => Math.min(8, availableParallelism())

export type Kind = "query" | "passage"

export interface Embedder {
  readonly model: TextModel
  /** One unit vector per text, in order. */
  embed(texts: string[], kind: Kind): Promise<Float32Array[]>
  close(): Promise<void>
}

/**
 * Models a long-running process keeps open between searches — the MCP server, where loading one costs
 * ~1 s a call. Whoever makes it closes it; a one-shot command never makes one.
 */
export interface WarmEmbedders {
  get(key: string, open: () => Promise<Embedder>): Promise<Embedder>
  close(): Promise<void>
}

export const warmEmbedders = (): WarmEmbedders => {
  const held = new Map<string, Promise<Embedder>>()
  return {
    get: (key, open) => {
      const known = held.get(key)
      if (known) return known
      const opening = open().then(serial)
      held.set(key, opening)
      // A model not downloaded yet must not stay refused once it is.
      opening.catch(() => held.delete(key))
      return opening
    },
    close: async () => {
      const all = [...held.values()]
      held.clear()
      await Promise.allSettled(all.map(async (one) => (await one).close()))
    },
  }
}

/** Two MCP calls may arrive at once; a session is not documented to take overlapping runs. */
const serial = (embedder: Embedder): Embedder => {
  let last: Promise<unknown> = Promise.resolve()
  return {
    model: embedder.model,
    embed: (texts, kind) => {
      const next = last.then(() => embedder.embed(texts, kind))
      last = next.catch(() => {})
      return next
    },
    close: () => embedder.close(),
  }
}

/** A text longer than the model's limit keeps its beginning and the closing special token. */
export const truncated = (ids: number[], max: number): number[] =>
  ids.length <= max ? ids : [...ids.slice(0, max - 1), ids.at(-1) as number]

export const unit = (vector: Float32Array): Float32Array => {
  let sum = 0
  for (const value of vector) sum += value * value
  const length = Math.sqrt(sum)
  return length === 0 ? vector : vector.map((value) => value / length)
}

/** The mean over a single text's tokens: one text a run, so no padding to mask. */
export const meanOf = (data: Float32Array, tokens: number, dims: number): Float32Array => {
  const mean = new Float32Array(dims)
  for (let token = 0; token < tokens; token++) {
    for (let dim = 0; dim < dims; dim++)
      mean[dim] = (mean[dim] as number) + (data[token * dims + dim] as number) / tokens
  }
  return mean
}

export const openEmbedder = async (
  model: TextModel,
  directory: string,
  { threads = defaultThreads() }: { threads?: number } = {},
): Promise<Embedder> => {
  const [{ Tokenizer }, ort] = await Promise.all([
    import("@huggingface/tokenizers"),
    import("@leemour/cli-messaging-onnx"),
  ])
  const path = (name: string) => join(directory, model.id, name)
  const tokenizer = new Tokenizer(
    JSON.parse(readFileSync(path("tokenizer.json"), "utf8")),
    JSON.parse(readFileSync(path("tokenizer_config.json"), "utf8")),
  )
  ort.env.wasm.numThreads = threads
  const session = await ort.InferenceSession.create(
    readFileSync(path(model.onnx)),
    model.externalData
      ? { externalData: [{ path: basename(model.externalData), data: readFileSync(path(model.externalData)) }] }
      : {},
  )
  const typeIds = session.inputNames.includes("token_type_ids")

  const one = async (text: string): Promise<Float32Array> => {
    const ids = truncated(tokenizer.encode(text).ids, model.maxTokens)
    const shape = [1, ids.length]
    const feeds: Record<string, InstanceType<typeof ort.Tensor>> = {
      input_ids: new ort.Tensor("int64", BigInt64Array.from(ids, BigInt), shape),
      attention_mask: new ort.Tensor("int64", new BigInt64Array(ids.length).fill(1n), shape),
    }
    if (typeIds) feeds.token_type_ids = new ort.Tensor("int64", new BigInt64Array(ids.length), shape)
    const output = await session.run(feeds)
    if (model.pooling === "sentence_embedding") {
      return unit(Float32Array.from(output.sentence_embedding?.data as Float32Array))
    }
    const hidden = output.last_hidden_state
    if (!hidden) throw new Error(`${model.id} gave no last_hidden_state`)
    return unit(meanOf(hidden.data as Float32Array, ids.length, hidden.dims.at(-1) as number))
  }

  return {
    model,
    embed: async (texts, kind) => {
      const vectors: Float32Array[] = []
      for (const text of texts) vectors.push(await one(`${model.prefix[kind]}${text}`))
      return vectors
    },
    close: () => session.release(),
  }
}
