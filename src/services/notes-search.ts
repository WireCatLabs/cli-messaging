import { CliError } from "@leemour/cli-core"
import { defaultThreads, type Embedder, isTextModelInstalled, textModelsDirectory } from "../embeddings/embed.js"
import { DEFAULT_TEXT_MODEL, type TextModel, textModel } from "../embeddings/models.js"
import { dateRange, timezoneOf } from "../search/lucene/dates.js"
import { parseLucene } from "../search/lucene/parser.js"
import { validateFields } from "../search/lucene/registry.js"
import { hasStems, type ResolvedNode } from "../search/lucene/resolved.js"
import type { QueryNode } from "../search/lucene/types.js"
import { createStemmer, DEFAULT_STEMMERS } from "../search/stem.js"
import type { NearestNote, Note, NoteHit } from "../store/index.js"
import type { MessageStore } from "../store/store.js"
import { vectorModelKey } from "./embeddings.js"

export interface NotesSearchRequest {
  text: string
  limit: number
  offset?: number
  /** Every word as written: no stems. */
  exact?: boolean
  newest?: boolean
  folderIds?: string[]
  source?: Note["source"]
  /** For `date:` — the zone a bare day is read in. */
  timezone?: string
  signal?: AbortSignal
}

/** A notes search in the query language messages use, for `search notes` and `search all` to call. */
export const searchNotesQuery = async (
  store: MessageStore,
  request: NotesSearchRequest,
): Promise<{ items: NoteHit[]; hasMore: boolean }> => {
  if (!request.text.trim()) throw new CliError("validation_error", "say what to find in the notes")
  const ast = validateFields(parseLucene(request.text, { defaultField: request.exact ? "exact" : "text" }))
  const timezone = timezoneOf(request.timezone)
  const resolve = (node: QueryNode): ResolvedNode => {
    if (node.kind === "boolean")
      return { ...node, clauses: node.clauses.map(({ occur, node }) => ({ occur, node: resolve(node) })) }
    if (node.field !== "date") return node
    return {
      ...node,
      resolution: {
        date: dateRange(
          node.value,
          node.operator === "range" ? (node.upper ?? "*") : node.value,
          node.operator === "range" ? node.lowerInclusive === true : true,
          node.operator === "range" ? node.upperInclusive === true : true,
          timezone,
          node.span,
        ),
      },
    }
  }
  const stemmers = hasStems(ast.root) ? await store.stemmers() : undefined
  if (stemmers === null)
    throw new CliError(
      "validation_error",
      "the store asks for stemmers this tool does not know — upgrade this tool, or search exact forms with --exact",
      { reason: "stemmer_unknown" },
    )
  return store.notes.search({
    root: resolve(ast.root),
    limit: request.limit,
    ...(request.offset === undefined ? {} : { offset: request.offset }),
    ...(request.newest ? { newest: true } : {}),
    ...(request.folderIds ? { folderIds: request.folderIds } : {}),
    ...(request.source ? { source: request.source } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
    ...(hasStems(ast.root) ? { stemmer: createStemmer(stemmers ?? DEFAULT_STEMMERS) } : {}),
  })
}

export interface NotesEmbedOptions {
  /** A local text model by id; e5-small, as conversations use, when absent. */
  model?: string
  /** How many chunks this run embeds at most; the next run continues. */
  maxChunks?: number
  env?: NodeJS.ProcessEnv
  threads?: number
}

export interface NotesEmbedded {
  model: string
  embedded: number
  /** Chunks still without a vector, when `maxChunks` stopped the run. */
  left: boolean
}

/** Chunks one batch embeds: one short transaction writes each, as for conversations. */
const NOTE_BATCH = 8

const localModel = (choice: string | undefined, env: NodeJS.ProcessEnv | undefined, command: string) => {
  const model = textModel(choice ?? DEFAULT_TEXT_MODEL)
  const directory = textModelsDirectory(env)
  if (!isTextModelInstalled(model, directory))
    throw new CliError("not_found", `${model.id} is not downloaded — \`${command} models text download ${model.id}\``)
  return { model, directory, key: vectorModelKey(model) }
}

const withLocal = async <T>(
  model: TextModel,
  directory: string,
  threads: number | undefined,
  work: (embedder: Embedder) => Promise<T>,
): Promise<T> => {
  const { openPool } = await import("../embeddings/pool.js")
  const embedder = await openPool(model, directory, { workers: 1, threads: threads ?? defaultThreads() })
  try {
    return await work(embedder)
  } finally {
    await embedder.close()
  }
}

/**
 * Embeds the notes' chunks that have no vector of the model yet, with the same model, prefixes and key
 * as conversations, so a chunk whose text a conversation shares is embedded once. A missing model is
 * an error naming the download command; nothing is downloaded.
 */
export const embedNotes = async (
  store: MessageStore,
  {
    model: choice,
    maxChunks = Number.POSITIVE_INFINITY,
    env,
    threads,
    command = "tg",
  }: NotesEmbedOptions & {
    command?: string
  } = {},
): Promise<NotesEmbedded> => {
  const { model, directory, key } = localModel(choice, env, command)
  if ((await store.notes.chunksToEmbed(key, { limit: 1 })).length === 0)
    return { model: model.id, embedded: 0, left: false }
  return withLocal(model, directory, threads, async (embedder) => {
    let embedded = 0
    let after: string | undefined
    while (embedded < maxChunks) {
      const batch = await store.notes.chunksToEmbed(key, {
        limit: Math.min(NOTE_BATCH, maxChunks - embedded),
        ...(after === undefined ? {} : { after }),
      })
      if (batch.length === 0) break
      after = batch.at(-1)?.hash
      const vectors = await embedder.embed(
        batch.map(({ text }) => text),
        "passage",
      )
      await store.saveVectors(
        key,
        model.dims,
        batch.map(({ hash }, index) => ({ hash, vector: vectors[index] as Float32Array })),
      )
      embedded += batch.length
    }
    const left =
      (await store.notes.chunksToEmbed(key, { limit: 1, ...(after === undefined ? {} : { after }) })).length > 0
    return { model: model.id, embedded, left }
  })
}

/** Notes nearest in meaning to the query, best first; only notes already embedded can be found. */
export const nearestNotes = async (
  store: MessageStore,
  query: string,
  {
    model: choice,
    limit,
    folderIds,
    source,
    env,
    threads,
    command = "tg",
  }: Omit<NotesEmbedOptions, "maxChunks"> & {
    limit: number
    folderIds?: string[]
    source?: Note["source"]
    command?: string
  },
): Promise<NearestNote[]> => {
  if (!query.trim()) throw new CliError("validation_error", "say what to find in the notes")
  const { model, directory, key } = localModel(choice, env, command)
  const [vector] = await withLocal(model, directory, threads, (embedder) => embedder.embed([query], "query"))
  return store.notes.nearest(key, vector as Float32Array, {
    limit,
    ...(folderIds ? { folderIds } : {}),
    ...(source ? { source } : {}),
  })
}
