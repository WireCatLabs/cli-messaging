import { CliError } from "@leemour/cli-core"
import { dateRange, timezoneOf } from "../search/lucene/dates.js"
import { parseLucene } from "../search/lucene/parser.js"
import { validateFields } from "../search/lucene/registry.js"
import { hasStems, type ResolvedNode } from "../search/lucene/resolved.js"
import type { QueryNode } from "../search/lucene/types.js"
import { createStemmer, DEFAULT_STEMMERS } from "../search/stem.js"
import type { Note, NoteHit } from "../store/index.js"
import type { MessageStore } from "../store/store.js"

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
