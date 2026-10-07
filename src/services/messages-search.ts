import { CliError } from "@leemour/cli-core"
import type { Messenger } from "../cli/messenger/context.js"
import { parseLocator } from "../domain/locator.js"
import { dateRange, timezoneOf } from "../search/lucene/dates.js"
import { parseLucene } from "../search/lucene/parser.js"
import { PRESET_VERSION } from "../search/lucene/presets.js"
import { FIELD_VERSION, validateAst, validateFields } from "../search/lucene/registry.js"
import { hasStems, hasText, isStemmed, type QueryExecution, type ResolvedNode } from "../search/lucene/resolved.js"
import { type QueryAst, type QueryNode, queryError, walkQuery } from "../search/lucene/types.js"
import { inSource, sourceOf } from "../search/query.js"
import { createStemmer, DEFAULT_STEMMERS, type Stemmer } from "../search/stem.js"
import type { StemsState } from "../store/sqlite/stems.js"
import { type AccountKey, CHAT_LIST_KEY, type ChatCompleteness, type MessageStore } from "../store/store.js"
import { chatAmong, type SearchFound, type SearchQuery, senderAmong } from "./messages.js"
import type { SearchRefreshed } from "./search-refresh.js"

export interface QueryMetadata {
  language: "lucene-v1"
  version: 1
  fieldsVersion: number
  presetVersion: number
  timezone: string
  order: "newest" | "relevance"
  /** Present when a `text` term or phrase was stemmed: which stemmer, and each word's stem. */
  stemming?: QueryStemming
}
export interface QueryStemming {
  applied: true
  analyzer: string
  terms: { word: string; stem: string; stemmer: string }[]
}
export interface SearchCoverage {
  state: "complete" | "partial" | "unknown" | "stale"
  /** The oldest `store fetch` of the chats in scope; `null` when one of them was never fetched. */
  lastSyncedAt: string | null
  /** Every account in scope has handed the store its whole chat list at least once. */
  inventoryComplete: boolean
  accounts: AccountKey[]
  chat?: string
  coveredChats: number
}
const positiveSources = (node: QueryNode): string[] =>
  node.kind === "predicate"
    ? node.field === "in"
      ? [node.value.toLowerCase()]
      : []
    : node.clauses.filter(({ occur }) => occur !== "mustNot").flatMap(({ node }) => positiveSources(node))
export interface Prepared {
  wordsReady: boolean
  stemsReady: boolean
  stemming?: QueryStemming
  execution: QueryExecution
  timezone: string
  scopeAccounts: AccountKey[]
  selectedChat?: { account: AccountKey; chatId: string }
}
export const prepareLucene = async (
  store: MessageStore,
  account: AccountKey,
  request: SearchQuery,
  messenger: Partial<Pick<Messenger, "savedChatId" | "app">>,
): Promise<Prepared> => {
  if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > QUERY_PAGE_LIMIT)
    queryError("invalid_limit", { start: 0, end: 0 }, `use 1–${QUERY_PAGE_LIMIT} results`)
  if (
    request.context !== undefined &&
    (!Number.isInteger(request.context) || request.context < 0 || request.context > 20)
  )
    queryError("invalid_context", { start: 0, end: 0 }, "use 0–20 surrounding messages")
  if (request.ast !== undefined && request.text !== undefined)
    queryError("query_conflict", { start: 0, end: 0 }, "give text or AST, not both")
  if (request.ast !== undefined && request.exact)
    queryError("query_conflict", { start: 0, end: 0 }, "an AST names its fields — use field exact instead of exact")
  const ast: QueryAst =
    request.ast !== undefined
      ? validateAst(request.ast)
      : request.text === undefined
        ? {
            version: 1,
            language: "lucene-v1",
            root: {
              kind: "predicate",
              field: "date",
              operator: "range",
              value: "*",
              upper: "*",
              lowerInclusive: true,
              upperInclusive: true,
              span: { start: 0, end: 0 },
            },
          }
        : validateFields(parseLucene(request.text, { defaultField: request.exact ? "exact" : "text" }))
  const timezone = timezoneOf(request.timezone)
  const held = await store.accounts()
  const providers = [...new Set([account.provider, ...held.map(({ provider }) => provider)])]
  const leaves = walkQuery(ast.root)
  const sources = positiveSources(ast.root).map((value) => sourceOf("in:", value, providers))
  for (const leaf of leaves.filter(({ field }) => field === "in")) sourceOf("in:", leaf.value, providers)
  const source = request.source === undefined ? undefined : sourceOf("--source", request.source, providers)
  if (request.accounts !== undefined && (request.source !== undefined || sources.length > 0))
    throw new CliError("validation_error", "this search reads the accounts it was given — not with in: or --source")
  if (request.accounts?.length === 0) throw new CliError("validation_error", "a search names at least one account")
  if (request.senders !== undefined && leaves.some(({ field }) => field === "from"))
    throw new CliError("validation_error", "--from and from: together — name the people once")
  const accounts =
    request.accounts ??
    (source !== undefined
      ? held.filter(({ provider }) => inSource(source, provider))
      : sources.length
        ? held.filter(({ provider }) => sources.some((source) => inSource(source, provider)))
        : [account])
  const scopeAccounts = accounts.map(({ provider, account }) => ({ provider, account }))
  const globalChat =
    request.chat === undefined ? undefined : await chatAmong(messenger, store, scopeAccounts, request.chat)
  const resolve = async (node: QueryNode): Promise<ResolvedNode> => {
    if (node.kind === "boolean")
      return {
        ...node,
        clauses: await Promise.all(node.clauses.map(async ({ occur, node }) => ({ occur, node: await resolve(node) }))),
      }
    if (node.field === "chat")
      return { ...node, resolution: { chat: await chatAmong(messenger, store, scopeAccounts, node.value) } }
    if (node.field === "from")
      return node.value.toLowerCase() === "me"
        ? { ...node, resolution: { outgoing: true } }
        : { ...node, resolution: { sender: await senderAmong(store, scopeAccounts, node.value) } }
    if (node.field === "date")
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
    return node
  }
  const root = await resolve(ast.root)
  const chats = leaves.filter(({ field }) => field === "chat")
  const selectedChat =
    globalChat ??
    (chats.length === 1 && requiresChat(ast.root, chats[0] as QueryNode)
      ? await chatAmong(messenger, store, scopeAccounts, (chats[0] as { value: string }).value)
      : undefined)
  if (leaves.some(({ field }) => field === "topic")) {
    if (!globalChat && (chats.length !== 1 || !requiresChat(ast.root, chats[0] as QueryNode)))
      queryError("topic_scope", { start: 0, end: 0 }, "name one required chat or use --chat")
  }
  const wordsReady = (await store.searchIndexState())?.ready === true
  if (hasText(ast.root) && !wordsReady) await indexNotReady(store, messenger.app?.command)
  const stems = await store.stemsState()
  const stemsReady = stems?.ready === true
  let stemmer: Stemmer | undefined
  if (hasStems(ast.root)) {
    if (!stems?.ready) stemsNotReady(stems, messenger.app?.command)
    // Ready means the setting is one this build knows, so `null` cannot reach here.
    stemmer = createStemmer((await store.stemmers()) ?? DEFAULT_STEMMERS)
  }
  const execution: QueryExecution = {
    root,
    accounts: scopeAccounts,
    limit: request.limit,
    ...(request.senders === undefined ? {} : { senders: request.senders }),
    ...(selectedChat ? { chat: selectedChat } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
    newest: request.newest,
    ...(stemmer ? { stemmer } : {}),
    ...(request.only ? { only: request.only } : {}),
  }
  return {
    execution,
    timezone,
    wordsReady,
    stemsReady,
    ...(stemmer ? { stemming: stemmingOf(ast.root, stemmer) } : {}),
    scopeAccounts,
    ...(selectedChat ? { selectedChat } : {}),
  }
}
const stemmingOf = (root: QueryNode, stemmer: Stemmer): QueryStemming => ({
  applied: true,
  analyzer: stemmer.identity,
  terms: walkQuery(root)
    .filter(isStemmed)
    .flatMap(({ value }) => stemmer.explain(value)),
})
const stemsNotReady = (state: StemsState | undefined, command: string | undefined): never => {
  const cli = command ? `${command} ` : ""
  const exact = "search exact forms with --exact or exact:"
  if (!state)
    throw new CliError(
      "validation_error",
      `this store has no stems yet — \`${cli}store migrate\` builds them, or ${exact}`,
      {
        reason: "index_not_ready",
        index: "message_stems",
      },
    )
  const details = {
    reason: "index_not_ready",
    index: "message_stems",
    cause: state.cause,
    done: state.filledThrough,
    total: state.watermark,
    pending: state.pending,
    built: state.built,
    wanted: state.wanted,
  }
  if (state.cause === "stemmer_changed")
    throw new CliError(
      "validation_error",
      `the stems were built by ${state.built}, and the store now asks for ${state.wanted} — run \`${cli}store reindex\` (or \`${cli}store migrate\`), or ${exact}`,
      details,
    )
  if (state.cause === "stemmer_unknown")
    throw new CliError(
      "validation_error",
      `the store asks for stemmers this tool does not know — upgrade this tool, or ${exact}`,
      details,
    )
  const percent = Math.floor((Math.min(state.filledThrough, state.watermark) / Math.max(state.watermark, 1)) * 100)
  throw new CliError(
    "validation_error",
    `stems are ${percent}% built${state.pending > 0 ? `, ${state.pending} messages queued` : ""} — run \`${cli}store migrate\`, or ${exact}`,
    details,
  )
}
const indexNotReady = async (store: MessageStore, command: string | undefined): Promise<never> => {
  const state = await store.searchIndexState()
  const migrate = `\`${command ? `${command} ` : ""}store migrate\``
  const progress = !state
    ? "this store file has no word index yet"
    : state.pendingNormalization > 0
      ? `${state.pendingNormalization} messages still wait to be normalized before their words are indexed`
      : `the word index is about ${Math.floor((state.filledThrough / Math.max(state.watermark, 1)) * 100)}% built (message ${state.filledThrough} of ${state.watermark})`
  throw new CliError(
    "validation_error",
    `the word index is not ready: ${progress}. ${state ? `Each search builds a little more; ${migrate} finishes it now` : `${migrate} builds it`}. Searches without words (has:, kind:, date:) work meanwhile`,
    { reason: "index_not_ready" },
  )
}
export const coverageOf = async (
  store: MessageStore,
  { scopeAccounts, selectedChat }: Prepared,
): Promise<{ completeness: (ChatCompleteness & AccountKey)[]; coverage: SearchCoverage }> => {
  const completeness: (ChatCompleteness & AccountKey)[] = []
  let inventoryComplete = scopeAccounts.length > 0
  for (const selected of scopeAccounts) {
    if (!(await store.syncState(selected, CHAT_LIST_KEY))) inventoryComplete = false
    const chatIds = selectedChat
      ? selected.provider === selectedChat.account.provider && selected.account === selectedChat.account.account
        ? [selectedChat.chatId]
        : []
      : (await store.chats(selected, {})).items.map(({ id }) => id)
    completeness.push(...(await store.chatCompleteness(selected, chatIds)).map((chat) => ({ ...chat, ...selected })))
  }
  const state =
    selectedChat && completeness.length > 0 && completeness.every(({ state }) => state === "complete")
      ? "complete"
      : completeness.some(({ state }) => state !== "unknown")
        ? "partial"
        : "unknown"
  return {
    completeness,
    coverage: {
      state,
      lastSyncedAt: oldestFetch(completeness),
      inventoryComplete,
      accounts: scopeAccounts,
      ...(selectedChat ? { chat: selectedChat.chatId } : {}),
      coveredChats: completeness.length,
    },
  }
}
const queryOf = (timezone: string, newest?: boolean, stemming?: QueryStemming): QueryMetadata => ({
  language: "lucene-v1",
  version: 1,
  fieldsVersion: FIELD_VERSION,
  presetVersion: PRESET_VERSION,
  timezone,
  order: newest ? "newest" : "relevance",
  ...(stemming ? { stemming } : {}),
})
export const searchLucene = async (
  store: MessageStore,
  account: AccountKey,
  request: SearchQuery,
  messenger: Partial<Pick<Messenger, "savedChatId" | "app">> = {},
): Promise<SearchFound> => {
  const prepared = await prepareLucene(store, account, request, messenger)
  const execute = store.matchQuery
  if (!execute)
    throw new CliError("validation_error", "this store does not support the Lucene profile — upgrade cli-messaging")
  const found = prepared.scopeAccounts.length ? await execute(prepared.execution) : { items: [], hasMore: false }
  const { completeness, coverage } = await coverageOf(store, prepared)
  const items = await Promise.all(
    found.items.map(async (hit) => {
      if (!request.context) return hit
      const locator = parseLocator(hit.locator)
      return {
        ...hit,
        context: await store.around({ provider: locator.provider, account: locator.account }, hit.chatId, hit.id, {
          before: request.context,
          after: request.context,
        }),
      }
    }),
  )
  return {
    ...found,
    items,
    corrections: [],
    wordsReady: prepared.wordsReady,
    stemsReady: prepared.stemsReady,
    completeness,
    query: queryOf(prepared.timezone, request.newest, prepared.stemming),
    coverage,
  }
}
const QUERY_PAGE_LIMIT = 1000
const oldestFetch = (chats: ChatCompleteness[]): string | null =>
  chats.length === 0 || chats.some(({ fetchedAt }) => fetchedAt === null)
    ? null
    : (chats.map(({ fetchedAt }) => fetchedAt as string).sort()[0] as string)
const requiresChat = (node: QueryNode, chat: QueryNode): boolean =>
  node === chat ||
  (node.kind === "boolean" && node.clauses.some((clause) => clause.occur === "must" && requiresChat(clause.node, chat)))

export type StatsGrouping = "chat" | "sender" | "day" | "hour"
export interface StatsRow {
  key: string
  name: string | null
  account?: AccountKey
  count: number
}
export interface MessageStats {
  refreshed?: SearchRefreshed
  by: StatsGrouping
  items: StatsRow[]
  total: number
  hasMore: boolean
  query: QueryMetadata
  coverage: SearchCoverage
  completeness: (ChatCompleteness & AccountKey)[]
}
export const calendarKey = (zone: string, by: "day" | "hour") => {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(by === "hour" ? { hour: "2-digit", hourCycle: "h23" } : {}),
  } as Intl.DateTimeFormatOptions)
  return (time: number) => {
    const part = Object.fromEntries(format.formatToParts(time).map(({ type, value }) => [type, value]))
    return `${part.year}-${part.month}-${part.day}${by === "hour" ? `T${part.hour}` : ""}`
  }
}
/** Distinct matching messages counted by chat, sender, or calendar day/hour in the query's timezone. */
export const statsLucene = async (
  store: MessageStore,
  account: AccountKey,
  request: SearchQuery & { by: StatsGrouping },
  messenger: Partial<Pick<Messenger, "savedChatId" | "app">> = {},
): Promise<MessageStats> => {
  const prepared = await prepareLucene(store, account, request, messenger)
  const count = store.countQuery
  if (!count)
    throw new CliError("validation_error", "this store does not support the Lucene profile — upgrade cli-messaging")
  const { by } = request
  const calendar = by === "day" || by === "hour"
  const groups = prepared.scopeAccounts.length ? await count(prepared.execution, calendar ? "time" : by) : []
  let rows: StatsRow[]
  if (calendar) {
    const keyOf = calendarKey(prepared.timezone, by)
    const totals = new Map<string, number>()
    for (const { id, count } of groups) {
      const key = keyOf(Number(id))
      totals.set(key, (totals.get(key) ?? 0) + count)
    }
    rows = [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => ({ key, name: null, count }))
  } else
    rows = groups
      .map(({ provider, account, id, name, outgoing, count }) => ({
        key: id ?? (outgoing ? "me" : "unknown"),
        name,
        ...(provider === undefined || account === undefined ? {} : { account: { provider, account } }),
        count,
      }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
  const { completeness, coverage } = await coverageOf(store, prepared)
  return {
    by,
    items: rows.slice(0, request.limit),
    total: groups.reduce((sum, { count }) => sum + count, 0),
    hasMore: rows.length > request.limit,
    query: queryOf(prepared.timezone, request.newest, prepared.stemming),
    coverage,
    completeness,
  }
}
