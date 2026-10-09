import { CliError } from "@wirecat/cli-core"
import { tagOf } from "../../domain/tags.js"
import {
  type Automaton,
  compileAutomaton,
  foldRegex,
  type MatchBudget,
  wildcardPattern,
} from "../../search/lucene/automaton.js"
import type { ResolvedNode, ResolvedPredicate } from "../../search/lucene/resolved.js"
import { isStemmed } from "../../search/lucene/resolved.js"
import { exhausted, QUERY_LIMITS, queryError } from "../../search/lucene/types.js"
import type { Stemmer } from "../../search/stem.js"
import type { SqlValue } from "../driver.js"
import { normalize } from "../normalize.js"
import { prefixOf } from "./lucene.js"
import { drainNoteIndex, type NoteIndexState, noteIndexState, noteIndexText } from "./note-index.js"
import { type Note, noteOf } from "./notes.js"
import type { StoreContext } from "./open.js"
import { stemmerCache } from "./stems.js"
import { dot } from "./vectors.js"

export interface NoteQuery {
  root: ResolvedNode
  limit: number
  offset?: number
  folderIds?: string[]
  source?: Note["source"]
  /** Newest first instead of best first. */
  newest?: boolean
  /** The store's stemmer, set when a leaf is stemmed. */
  stemmer?: Stemmer
  signal?: AbortSignal
}

export interface NoteHit {
  ref: string
  note: Note
  /** bm25 of the words or stems; lower is better. `null` when ranked by time. */
  relevance: number | null
  /** Whether the note holds the exact forms, when the search was stemmed. */
  exact?: boolean
}

/** The fields a note has. A message-only field (`from:`, `chat:`, …) is refused rather than matching nothing. */
export const NOTE_FIELDS = ["text", "exact", "body", "tag", "date", "in"] as const

interface Fragment {
  sql: string
  params: SqlValue[]
  /** False when the SQL only narrows the candidates and a JS test decides. */
  exact: boolean
  fts?: string
  stems?: string
}

const quoted = (value: string) => `"${value.replaceAll('"', '""')}"`
const bound = (sql: string, ...params: SqlValue[]): Fragment => ({ sql, params, exact: true })
const combine = (parts: Fragment[], operator: "AND" | "OR"): Fragment => ({
  sql: parts.length ? `(${parts.map(({ sql }) => sql).join(` ${operator} `)})` : operator === "AND" ? "1" : "0",
  params: parts.flatMap(({ params }) => params),
  exact: parts.every(({ exact }) => exact),
})
const wordMatch = (match: string): Fragment => ({
  sql: "n.pk IN (SELECT rowid FROM note_words WHERE note_words MATCH ?)",
  params: [`normalized_text : (${match})`],
  exact: true,
  fts: match,
})

/** Notes matching a parsed query, by the same language as messages; runs in one read snapshot. */
export const searchNotes = (context: StoreContext, query: NoteQuery): { items: NoteHit[]; hasMore: boolean } => {
  const { database } = context
  const started = context.now()
  const budget: MatchBudget = { work: 0 }
  let expansions = 0
  const check = () => {
    if (query.signal?.aborted)
      throw new CliError("validation_error", "search was aborted", { reason: "query_aborted", complete: false })
    if (context.now() - started > QUERY_LIMITS.milliseconds) exhausted("time")
  }
  const tests = new Map<ResolvedPredicate, (text: string) => boolean>()
  const fragments = new Map<ResolvedPredicate, Fragment>()
  const automaton = (pattern: string, node: ResolvedPredicate): Automaton => compileAutomaton(pattern, node.span)

  const leaf = (node: ResolvedPredicate): Fragment => {
    const { field, operator, value } = node
    if (!(NOTE_FIELDS as readonly string[]).includes(field))
      queryError("unsupported_field", node.span, `${field}: is not a note field — notes take ${NOTE_FIELDS.join(", ")}`)
    if ((field === "text" || field === "exact") && value === "") return bound("0")
    if (isStemmed(node)) {
      if (!query.stemmer) throw new Error("a stemmed leaf reached the notes search without the store's stemmer")
      const text = normalize(value)
      if (!/[\p{L}\p{N}]/u.test(text)) return bound("0")
      const stems = query.stemmer.phrases(value)
      return {
        sql: `n.pk IN (SELECT rowid FROM note_words WHERE note_words MATCH ?)${stems ? " OR n.pk IN (SELECT rowid FROM note_stems WHERE note_stems MATCH ?)" : ""}`,
        params: [`normalized_text : (${quoted(text)})`, ...(stems ? [`stems : (${stems})`] : [])],
        exact: true,
        fts: quoted(text),
        ...(stems ? { stems } : {}),
      }
    }
    if (field === "text" || field === "exact") {
      if (operator === "term" || operator === "phrase") {
        const text = normalize(value)
        const stems = query.stemmer?.phrases(value)
        return /[\p{L}\p{N}]/u.test(text) ? { ...wordMatch(quoted(text)), ...(stems ? { stems } : {}) } : bound("0")
      }
      const pattern = operator === "wildcard" ? wildcardPattern(normalize(value)) : foldRegex(value, node.span)
      const matcher = automaton(pattern, node)
      const prefix = prefixOf(pattern)
      const terms = database
        .prepare(
          `SELECT term FROM note_words_vocab WHERE col='normalized_text'${prefix ? " AND term>=? AND term<=?" : ""} ORDER BY term LIMIT ?`,
        )
        .all(...(prefix ? [prefix, `${prefix}\u{10ffff}`] : []), QUERY_LIMITS.expansions + 1)
      expansions += terms.length
      if (expansions > QUERY_LIMITS.expansions) exhausted("term expansions")
      const matches = terms.flatMap(({ term }) => {
        check()
        return matcher.test(String(term), budget) ? [quoted(String(term))] : []
      })
      return matches.length ? wordMatch(matches.join(" OR ")) : bound("0")
    }
    if (field === "body") {
      if (operator === "term" || operator === "phrase") return bound("n.text = ?", value)
      const matcher = automaton(operator === "wildcard" ? wildcardPattern(value) : value, node)
      tests.set(node, (text) => matcher.test(text, budget))
      return { sql: "1", params: [], exact: false }
    }
    if (field === "tag") {
      const tag = tagOf(value)
      if (tag === undefined) queryError("invalid_tag", node.span)
      // A label on a folder or subfolder labels every note under it, at any depth.
      return bound(
        "(n.pk IN (SELECT taggable_pk FROM tags WHERE tag = ? AND taggable_type = 'note') OR EXISTS (" +
          "SELECT 1 FROM owner_targets o JOIN tags l ON l.taggable_type = 'owner' AND l.taggable_pk = o.pk " +
          "WHERE l.tag = ? AND o.folder_id = n.folder_id " +
          "AND (o.folder_path = '' OR substr(n.path, 1, length(o.folder_path) + 1) = o.folder_path || '/')))",
        tag,
        tag,
      )
    }
    if (field === "date") {
      const range = node.resolution?.date
      if (!range) queryError("invalid_ast", node.span)
      return combine(
        [
          ...(range.lower === undefined
            ? []
            : [bound(`n.updated_at ${range.lowerInclusive ? ">=" : ">"} ?`, range.lower)]),
          ...(range.upper === undefined
            ? []
            : [bound(`n.updated_at ${range.upperInclusive ? "<=" : "<"} ?`, range.upper)]),
        ],
        "AND",
      )
    }
    return bound(["notes", "note"].includes(value.toLowerCase()) ? "1" : "0")
  }

  const compile = (node: ResolvedNode): Fragment => {
    if (node.kind === "predicate") {
      const fragment = leaf(node)
      const wrapped = { ...fragment, sql: `(${fragment.sql})` }
      fragments.set(node, wrapped)
      return wrapped
    }
    const parts = node.clauses.map(({ occur, node }) => ({ occur, part: compile(node) }))
    const must = parts.filter(({ occur }) => occur === "must").map(({ part }) => part)
    const should = parts.filter(({ occur }) => occur === "should").map(({ part }) => part)
    const not = parts
      .filter(({ occur }) => occur === "mustNot")
      .map(({ part }) =>
        part.exact ? { ...part, sql: `NOT coalesce(${part.sql},0)` } : { sql: "1", params: [], exact: false },
      )
    return combine([must.length ? combine(must, "AND") : combine(should, "OR"), ...not], "AND")
  }
  const required = (node: ResolvedNode, index: "fts" | "stems"): string | undefined => {
    if (node.kind === "predicate") return fragments.get(node)?.[index]
    const must = node.clauses.filter(({ occur }) => occur === "must")
    const parts = (must.length ? must : node.clauses.filter(({ occur }) => occur === "should")).map(({ node }) =>
      required(node, index),
    )
    if (must.length) {
      const known = parts.filter((part): part is string => part !== undefined)
      return known.length ? known.map((part) => `(${part})`).join(" AND ") : undefined
    }
    return parts.length && parts.every((part) => part !== undefined)
      ? parts.map((part) => `(${part})`).join(" OR ")
      : undefined
  }

  database.exec("BEGIN")
  try {
    check()
    const expression = compile(query.root)
    const stemmed = [...fragments.keys()].some(isStemmed)
    const scope = combine(
      [
        bound("n.deleted_at IS NULL"),
        ...(query.folderIds?.length
          ? [bound("n.folder_id IN (SELECT value FROM json_each(?))", JSON.stringify(query.folderIds))]
          : []),
        ...(query.source ? [bound("n.source = ?", query.source)] : []),
      ],
      "AND",
    )
    const where = combine([scope, expression], "AND")
    const ranking = query.newest ? undefined : required(query.root, stemmed ? "stems" : "fts")
    const exactTier = stemmed ? required(query.root, "fts") : undefined
    const ctes: string[] = []
    const cteParams: SqlValue[] = []
    if (ranking) {
      const table = stemmed ? "note_stems" : "note_words"
      ctes.push(
        `f(pk, rank) AS MATERIALIZED (SELECT rowid, bm25(${table}, 1.0, 0.0) FROM ${table} WHERE ${table} MATCH ?)`,
      )
      cteParams.push(`${stemmed ? "stems" : "normalized_text"} : (${ranking})`)
    }
    if (exactTier) {
      ctes.push("x(pk) AS MATERIALIZED (SELECT rowid FROM note_words WHERE note_words MATCH ?)")
      cteParams.push(`normalized_text : (${exactTier})`)
    }
    const order = query.newest
      ? "n.updated_at DESC, n.id"
      : `${exactTier ? "exact DESC, " : ""}${ranking ? "f.rank IS NULL, f.rank, " : ""}n.updated_at DESC, n.id`
    const offset = query.offset ?? 0
    // With a JS test the SQL only names candidates: every leaf's SQL answer comes along, so the test sees it.
    const leaves = [...fragments.entries()].filter(([node]) => !tests.has(node))
    const projection = tests.size
      ? leaves.map(([, fragment], index) => `, coalesce(${fragment.sql}, 0) AS q${index}`).join("")
      : ""
    const window = tests.size ? QUERY_LIMITS.candidates + 1 : query.limit + offset + 1
    const rows = database
      .prepare(
        `${ctes.length ? `WITH ${ctes.join(", ")} ` : ""}SELECT n.*, ${ranking ? "f.rank" : "NULL"} AS relevance${exactTier ? ", n.pk IN (SELECT pk FROM x) AS exact" : ""}${projection}
           FROM notes n${ranking ? " LEFT JOIN f ON f.pk = n.pk" : ""} WHERE ${where.sql} ORDER BY ${order} LIMIT ?`,
      )
      .all(
        ...cteParams,
        ...leaves.flatMap(([, fragment]) => (tests.size ? fragment.params : [])),
        ...where.params,
        window,
      )
    if (tests.size && rows.length > QUERY_LIMITS.candidates) exhausted("candidates")
    const evaluate = (node: ResolvedNode, row: Record<string, unknown>, text: string): boolean => {
      if (node.kind === "predicate") {
        const test = tests.get(node)
        return test ? test(text) : Number(row[`q${leaves.findIndex(([leaf]) => leaf === node)}`]) === 1
      }
      const must = node.clauses.filter(({ occur }) => occur === "must")
      const should = node.clauses.filter(({ occur }) => occur === "should")
      const not = node.clauses.filter(({ occur }) => occur === "mustNot")
      return (
        (must.length
          ? must.every(({ node }) => evaluate(node, row, text))
          : should.length > 0 && should.some(({ node }) => evaluate(node, row, text))) &&
        not.every(({ node }) => !evaluate(node, row, text))
      )
    }
    const matched = tests.size
      ? rows.filter((row) => {
          check()
          const text = noteIndexText(row.title === null ? null : String(row.title), String(row.text))
          budget.work += text.length
          if (budget.work > QUERY_LIMITS.work) exhausted("detector work")
          return evaluate(query.root, row, text)
        })
      : rows
    const page = matched.slice(offset, offset + query.limit)
    return {
      items: page.map((row) => {
        const note = noteOf(row)
        return {
          ref: `note:${note.id}`,
          note,
          relevance: row.relevance === null || row.relevance === undefined ? null : Number(row.relevance),
          ...(exactTier ? { exact: Number(row.exact) === 1 } : {}),
        }
      }),
      hasMore: matched.length > offset + query.limit,
    }
  } finally {
    database.exec("COMMIT")
  }
}

export interface NoteChunkToEmbed {
  hash: string
  text: string
}

export interface NearestNote {
  ref: string
  note: Note
  /** Cosine of the note's best chunk; higher is nearer. */
  score: number
  /** The stretch of the indexed text (title, then text) that chunk holds. */
  range: { start: number; end: number }
}

export interface NoteSearch {
  /** Indexes what was written since, then searches; a note written a moment ago is found. */
  search(query: NoteQuery): Promise<{ items: NoteHit[]; hasMore: boolean }>
  indexState(): Promise<NoteIndexState | undefined>
  /** Live notes' chunks with no vector of `model`, by hash from `after`, each with its text cut again. */
  chunksToEmbed(model: string, options: { after?: string; limit: number }): Promise<NoteChunkToEmbed[]>
  /** Notes nearest in meaning to `query`, each scored by its best chunk. Vectors are unit length. */
  nearest(
    model: string,
    query: Float32Array,
    options: { limit: number; folderIds?: string[]; source?: Note["source"] },
  ): Promise<NearestNote[]>
}

const SCAN_PAGE = 5_000

export const noteSearchOver = (context: StoreContext): NoteSearch => {
  const { database } = context
  const stemmerFor = stemmerCache()
  const drain = () => drainNoteIndex(database, stemmerFor)
  const filters = (folderIds: string[] | undefined, source: Note["source"] | undefined) => ({
    sql: `${folderIds?.length ? " AND n.folder_id IN (SELECT value FROM json_each(?))" : ""}${source ? " AND n.source = ?" : ""}`,
    params: [...(folderIds?.length ? [JSON.stringify(folderIds)] : []), ...(source ? [source] : [])] as SqlValue[],
  })
  return {
    search: async (query) => {
      drain()
      return searchNotes(context, query)
    },
    indexState: async () => noteIndexState(database),
    chunksToEmbed: async (model, { after, limit }) => {
      drain()
      return database
        .prepare(
          `SELECT k.content_hash AS hash, min(k.note_pk) AS pk, k.text_start AS start, k.text_end AS end
             FROM note_chunks k JOIN notes n ON n.pk = k.note_pk
            WHERE n.deleted_at IS NULL AND k.content_hash > ?
              AND NOT EXISTS (SELECT 1 FROM chunk_vectors v WHERE v.model = ? AND v.content_hash = k.content_hash)
            GROUP BY k.content_hash ORDER BY k.content_hash LIMIT ?`,
        )
        .all(after ?? "", model, limit)
        .flatMap((row) => {
          const note = database.prepare("SELECT title, text FROM notes WHERE pk = ?").get(Number(row.pk))
          if (!note) return []
          const text = noteIndexText(note.title === null ? null : String(note.title), String(note.text))
          return [{ hash: String(row.hash), text: text.slice(Number(row.start), Number(row.end)) }]
        })
    },
    nearest: async (model, query, { limit, folderIds, source }) => {
      drain()
      const scope = filters(folderIds, source)
      const page = database.prepare(
        `SELECT k.note_pk AS pk, k.seq, k.text_start AS start, k.text_end AS end, v.vector FROM note_chunks k
           CROSS JOIN notes n ON n.pk = k.note_pk
           JOIN chunk_vectors v ON v.model = ? AND v.content_hash = k.content_hash
          WHERE n.deleted_at IS NULL${scope.sql} AND (k.note_pk, k.seq) > (?, ?)
          ORDER BY k.note_pk, k.seq LIMIT ?`,
      )
      const best = new Map<number, { score: number; start: number; end: number }>()
      let after = { pk: 0, seq: -1 }
      for (;;) {
        const rows = page.all(model, ...scope.params, after.pk, after.seq, SCAN_PAGE)
        for (const row of rows) {
          const score = dot(query, row.vector as Uint8Array)
          const pk = Number(row.pk)
          if (score > (best.get(pk)?.score ?? Number.NEGATIVE_INFINITY))
            best.set(pk, { score, start: Number(row.start), end: Number(row.end) })
        }
        const last = rows.at(-1)
        if (!last || rows.length < SCAN_PAGE) break
        after = { pk: Number(last.pk), seq: Number(last.seq) }
      }
      const read = database.prepare("SELECT * FROM notes WHERE pk = ?")
      return [...best.entries()]
        .sort(([, a], [, b]) => b.score - a.score)
        .slice(0, limit)
        .flatMap(([pk, { score, start, end }]) => {
          const row = read.get(pk)
          if (!row) return []
          const note = noteOf(row)
          return [{ ref: `note:${note.id}`, note, score, range: { start, end } }]
        })
    },
  }
}
