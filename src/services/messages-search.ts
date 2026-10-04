import { CliError } from "@leemour/cli-core"
import type { Messenger } from "../cli/messenger/context.js"
import { parseLocator } from "../domain/locator.js"
import { dateRange, timezoneOf } from "../search/lucene/dates.js"
import { parseLucene } from "../search/lucene/parser.js"
import { PRESET_VERSION } from "../search/lucene/presets.js"
import { FIELD_VERSION, validateAst, validateFields } from "../search/lucene/registry.js"
import { hasText, type QueryExecution, type ResolvedNode } from "../search/lucene/resolved.js"
import { type QueryAst, type QueryNode, queryError, walkQuery } from "../search/lucene/types.js"
import { inSource, sourceOf } from "../search/query.js"
import { type AccountKey, CHAT_LIST_KEY, type ChatCompleteness, type MessageStore } from "../store/store.js"
import { chatAmong, type SearchFound, type SearchQuery, senderAmong } from "./messages.js"

export interface QueryMetadata {
  language: "lucene-v1"
  version: 1
  fieldsVersion: number
  presetVersion: number
  timezone: string
  order: "newest" | "relevance"
}
export interface SearchCoverage {
  state: "complete" | "partial" | "unknown"
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
export const searchLucene = async (
  store: MessageStore,
  account: AccountKey,
  request: SearchQuery,
  messenger: Partial<Pick<Messenger, "savedChatId">> = {},
): Promise<SearchFound> => {
  if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > QUERY_PAGE_LIMIT)
    queryError("invalid_limit", { start: 0, end: 0 }, `use 1–${QUERY_PAGE_LIMIT} results`)
  if (
    request.context !== undefined &&
    (!Number.isInteger(request.context) || request.context < 0 || request.context > 20)
  )
    queryError("invalid_context", { start: 0, end: 0 }, "use 0–20 surrounding messages")
  if (request.ast !== undefined && request.text !== undefined)
    queryError("query_conflict", { start: 0, end: 0 }, "give text or AST, not both")
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
        : validateFields(parseLucene(request.text))
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
  if (hasText(ast.root) && !wordsReady)
    throw new CliError("validation_error", "the word index is not ready — run store migrate before strict search", {
      reason: "index_not_ready",
    })
  const execute = store.matchQuery
  if (!execute)
    throw new CliError("validation_error", "this store does not support the Lucene profile — upgrade cli-messaging")
  const execution: QueryExecution = {
    root,
    accounts: scopeAccounts,
    limit: request.limit,
    ...(request.senders === undefined ? {} : { senders: request.senders }),
    ...(selectedChat ? { chat: selectedChat } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
    newest: request.newest,
  }
  const found = scopeAccounts.length ? await execute(execution) : { items: [], hasMore: false }
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
  const state =
    selectedChat && completeness.length > 0 && completeness.every(({ state }) => state === "complete")
      ? "complete"
      : completeness.some(({ state }) => state !== "unknown")
        ? "partial"
        : "unknown"
  return {
    ...found,
    items,
    corrections: [],
    wordsReady,
    completeness,
    query: {
      language: "lucene-v1",
      version: 1,
      fieldsVersion: FIELD_VERSION,
      presetVersion: PRESET_VERSION,
      timezone,
      order: request.newest ? "newest" : "relevance",
    },
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
const QUERY_PAGE_LIMIT = 1000
const oldestFetch = (chats: ChatCompleteness[]): string | null =>
  chats.length === 0 || chats.some(({ fetchedAt }) => fetchedAt === null)
    ? null
    : (chats.map(({ fetchedAt }) => fetchedAt as string).sort()[0] as string)
const requiresChat = (node: QueryNode, chat: QueryNode): boolean =>
  node === chat ||
  (node.kind === "boolean" && node.clauses.some((clause) => clause.occur === "must" && requiresChat(clause.node, chat)))
