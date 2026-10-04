import { CliError } from "@leemour/cli-core"
import type { Page } from "../../domain/models.js"
import { type Automaton, compileAutomaton, type MatchBudget, wildcardPattern } from "../../search/lucene/automaton.js"
import { PRESETS } from "../../search/lucene/presets.js"
import { parseBytes } from "../../search/lucene/registry.js"
import type { QueryExecution, ResolvedNode, ResolvedPredicate } from "../../search/lucene/resolved.js"
import { exhausted, QUERY_LIMITS, queryError } from "../../search/lucene/types.js"
import { inSource } from "../../search/query.js"
import type { SqlValue } from "../driver.js"
import { normalize } from "../normalize.js"
import type { ScoredHit } from "../store.js"
import type { StoreContext } from "./open.js"
import { hitsByPk } from "./search.js"

interface Fragment {
  sql: string
  params: SqlValue[]
  exact: boolean
  fts?: string
}
interface Leaf {
  node: ResolvedPredicate
  fragment: Fragment
  test?: (text: string, attachments: string[]) => boolean
}
const quoted = (value: string) => `"${value.replaceAll('"', '""')}"`
const combine = (parts: Fragment[], operator: "AND" | "OR"): Fragment => ({
  sql: parts.length ? `(${parts.map(({ sql }) => sql).join(` ${operator} `)})` : operator === "AND" ? "1" : "0",
  params: parts.flatMap(({ params }) => params),
  exact: parts.every(({ exact }) => exact),
})
const prefixOf = (pattern: string): string => {
  if (pattern.includes("|")) return ""
  let prefix = ""
  for (const c of pattern) {
    if (!/[\p{L}\p{N}_ -]/u.test(c)) {
      if (["?", "*", "{"].includes(c)) prefix = [...prefix].slice(0, -1).join("")
      break
    }
    prefix += c
  }
  return prefix
}

const wordMatch = (match: string): Fragment => ({
  sql: "m.pk IN (SELECT rowid FROM message_words WHERE message_words MATCH ?)",
  params: [`normalized_text : (${match})`],
  exact: true,
  fts: match,
})
export const matchQuery = async (context: StoreContext, execution: QueryExecution): Promise<Page<ScoredHit>> => {
  const { database } = context
  const started = context.now()
  const budget: MatchBudget = { work: 0 }
  let states = 0,
    expansions = 0
  const patterns = new Map<string, Automaton>()
  const expanded = new Map<string, Fragment>()
  const check = () => {
    if (execution.signal?.aborted)
      throw new CliError("validation_error", "search was aborted", { reason: "query_aborted", complete: false })
    if (context.now() - started > QUERY_LIMITS.milliseconds) exhausted("time")
  }
  const patternOf = (pattern: string, node: ResolvedPredicate) => {
    check()
    const known = patterns.get(pattern)
    if (known) return known
    const automaton = compileAutomaton(pattern, node.span)
    states += automaton.states
    if (states > QUERY_LIMITS.states) exhausted("automaton states")
    patterns.set(pattern, automaton)
    return automaton
  }
  const fragments = new Map<ResolvedPredicate, Leaf>()
  const createLeaf = (node: ResolvedPredicate): Leaf => {
    const { field, operator, value, resolution } = node
    let fragment: Fragment
    let test: Leaf["test"]
    const bound = (sql: string, ...params: SqlValue[]): Fragment => ({ sql, params, exact: true })
    if (field === "text" && value === "") fragment = bound("0")
    else if (field === "body" && value === "") fragment = bound("m.text = ?", "")
    else if (field === "text") {
      if (operator === "term" || operator === "phrase") {
        const text = normalize(value)
        fragment = /[\p{L}\p{N}]/u.test(text) ? wordMatch(quoted(text)) : bound("0")
      } else {
        const pattern = operator === "wildcard" ? wildcardPattern(normalize(value)) : value
        const automaton = patternOf(pattern, node)
        const cached = expanded.get(pattern)
        if (cached) return { node, fragment: cached }
        const prefix = prefixOf(pattern)
        const terms = database
          .prepare(
            `SELECT term FROM message_words_vocab WHERE col='normalized_text'${prefix ? " AND term>=? AND term<=?" : ""} ORDER BY term LIMIT ?`,
          )
          .all(...(prefix ? [prefix, `${prefix}\u{10ffff}`] : []), QUERY_LIMITS.expansions + 1)
        expansions += terms.length
        if (expansions > QUERY_LIMITS.expansions) exhausted("term expansions")
        const matches = terms.flatMap(({ term }) => {
          check()
          return automaton.test(String(term), budget) ? [quoted(String(term))] : []
        })
        fragment = matches.length ? wordMatch(matches.join(" OR ")) : bound("0")
        expanded.set(pattern, fragment)
      }
    } else if (field === "body") {
      if (operator === "term" || operator === "phrase") fragment = bound("m.text = ?", value)
      else {
        const automaton = patternOf(operator === "wildcard" ? wildcardPattern(value) : value, node)
        fragment = { sql: "1", params: [], exact: false }
        test = (text) => automaton.test(text, budget)
      }
    } else if (field === "preset") {
      fragment = { sql: "1", params: [], exact: false }
      test = (text, attachments) => {
        budget.work += text.length
        if (budget.work > QUERY_LIMITS.work) exhausted("detector work")
        return PRESETS[value.toLowerCase()]?.candidate(text, attachments) ?? false
      }
    } else if (field === "filename" || field === "mime") {
      const column = field === "filename" ? "name" : "mime"
      const wanted = normalize(value)
      const automaton =
        operator === "wildcard" || operator === "regex"
          ? patternOf(operator === "wildcard" ? wildcardPattern(wanted) : value, node)
          : undefined
      const fits = (known: string) => {
        const name = normalize(known)
        budget.work += name.length
        if (budget.work > QUERY_LIMITS.work) exhausted("detector work")
        if (automaton) return automaton.test(name, budget)
        return name === wanted || (column === "mime" && !wanted.includes("/") && name.startsWith(`${wanted}/`))
      }
      const scope = combine(
        execution.accounts.map(({ provider, account }) => bound("ac.provider=? AND ac.native_id=?", provider, account)),
        "OR",
      )
      const page = database.prepare(
        `SELECT att.pk AS pk, att.message_pk AS message, att.${column} AS value FROM attachments att JOIN messages m ON m.pk=att.message_pk JOIN accounts ac ON ac.pk=m.account_pk WHERE att.pk > ? AND att.${column} IS NOT NULL AND m.deleted_at IS NULL AND ${scope.sql} ORDER BY att.pk LIMIT 5000`,
      )
      const messages = new Set<number>()
      for (let rows = page.all(0, ...scope.params); rows.length > 0; ) {
        check()
        for (const row of rows) if (fits(String(row.value))) messages.add(Number(row.message))
        rows = page.all(Number(rows.at(-1)?.pk), ...scope.params)
      }
      fragment = bound("m.pk IN (SELECT value FROM json_each(?))", JSON.stringify([...messages]))
    } else if (field === "size") {
      const conditions =
        operator === "range"
          ? [
              ...(value === "*"
                ? []
                : [bound(`att.size ${node.lowerInclusive ? ">=" : ">"} ?`, parseBytes(value, node.span))]),
              ...(node.upper === undefined || node.upper === "*"
                ? []
                : [bound(`att.size ${node.upperInclusive ? "<=" : "<"} ?`, parseBytes(node.upper, node.span))]),
            ]
          : [bound("att.size = ?", parseBytes(value, node.span))]
      const range = combine(conditions, "AND")
      fragment = bound(
        `EXISTS (SELECT 1 FROM attachments att WHERE att.message_pk=m.pk AND att.size IS NOT NULL AND ${range.sql})`,
        ...range.params,
      )
    } else if (field === "date") {
      const range = resolution?.date
      if (!range) queryError("invalid_ast", node.span)
      const conditions: Fragment[] = []
      if (range.lower !== undefined)
        conditions.push(bound(`m.sent_at ${range.lowerInclusive ? ">=" : ">"} ?`, range.lower))
      if (range.upper !== undefined)
        conditions.push(bound(`m.sent_at ${range.upperInclusive ? "<=" : "<"} ?`, range.upper))
      fragment = combine(conditions, "AND")
    } else if (field === "chat") {
      const chat = resolution?.chat
      if (!chat) queryError("invalid_ast", node.span)
      fragment = bound(
        "m.chat_pk IN (SELECT cc.pk FROM chats cc JOIN accounts aa ON aa.pk=cc.account_pk WHERE aa.provider=? AND aa.native_id=? AND cc.native_id=?)",
        chat.account.provider,
        chat.account.account,
        chat.chatId,
      )
    } else if (field === "from") {
      const sender = resolution?.sender
      if (resolution?.outgoing) fragment = bound("m.outgoing = 1")
      else if (sender)
        fragment = bound(
          "m.sender_identity_pk IN (SELECT ii.pk FROM identities ii WHERE ii.provider=? AND ii.native_id=?)",
          sender.provider,
          sender.id,
        )
      else queryError("invalid_ast", node.span)
    } else if (field === "topic") fragment = bound("m.thread_native_id = ?", value)
    else if (field === "kind") {
      const kind = value.toLowerCase()
      fragment = bound(
        "CASE WHEN json_extract(c.provider_metadata,'$.peerKind') IN ('private','saved','bot','service','group','channel','unknown') THEN json_extract(c.provider_metadata,'$.peerKind') WHEN c.kind='dialog' AND json_extract(c.provider_metadata,'$.isBot')=1 THEN 'bot' WHEN c.kind='dialog' THEN 'private' ELSE c.kind END = ?",
        kind,
      )
    } else if (field === "has") {
      const kind = value.toLowerCase()
      fragment =
        kind === "link"
          ? bound(
              "(m.pk IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?) OR EXISTS (SELECT 1 FROM attachments att WHERE att.message_pk=m.pk AND att.kind IN ('share','webpage')))",
              quoted("://"),
            )
          : kind === "attachment"
            ? bound("EXISTS (SELECT 1 FROM attachments att WHERE att.message_pk=m.pk)")
            : bound("EXISTS (SELECT 1 FROM attachments att WHERE att.message_pk=m.pk AND att.kind=?)", kind)
    } else if (field === "in") {
      const source = value.toLowerCase()
      const chosen = execution.accounts.filter(({ provider }) => inSource(source, provider))
      fragment = chosen.length
        ? combine(
            chosen.map(({ provider, account }) => bound("ac.provider=? AND ac.native_id=?", provider, account)),
            "OR",
          )
        : bound("0")
    } else queryError("unsupported_field", node.span)
    return { node, fragment: { ...fragment, sql: `(${fragment.sql})` }, ...(test ? { test } : {}) }
  }
  const compile = (node: ResolvedNode): Fragment => {
    if (node.kind === "predicate") {
      const leaf = createLeaf(node)
      fragments.set(node, leaf)
      return leaf.fragment
    }
    const clauses = node.clauses.map(({ occur, node }) => ({ occur, part: compile(node) }))
    const required = clauses.filter(({ occur }) => occur === "must")
    const optional = clauses.filter(({ occur }) => occur === "should")
    const prohibited = clauses.filter(({ occur }) => occur === "mustNot")
    const positive = required.length
      ? combine(
          required.map(({ part }) => part),
          "AND",
        )
      : combine(
          optional.map(({ part }) => part),
          "OR",
        )
    const negatives = prohibited.map(({ part }) =>
      part.exact ? { ...part, sql: `NOT coalesce(${part.sql},0)` } : { sql: "1", params: [], exact: false },
    )
    const result = combine([positive, ...negatives], "AND")
    return { ...result, exact: clauses.every(({ part }) => part.exact) }
  }
  check()
  if (execution.accounts.length === 0) queryError("invalid_scope", { start: 0, end: 0 })
  const expression = compile(execution.root)
  const scopeParts = execution.accounts.map(({ provider, account }) => ({
    sql: "ac.provider=? AND ac.native_id=?",
    params: [provider, account],
    exact: true,
  }))
  let scope = combine(scopeParts, "OR")
  if (execution.chat)
    scope = combine(
      [
        scope,
        {
          sql: "ac.provider=? AND ac.native_id=? AND c.native_id=?",
          params: [execution.chat.account.provider, execution.chat.account.account, execution.chat.chatId],
          exact: true,
        },
      ],
      "AND",
    )
  else scope = combine([scope, { sql: "c.is_searchable=1", params: [], exact: true }], "AND")
  if (execution.senders)
    scope = combine(
      [
        scope,
        combine(
          execution.senders.map(({ provider, id }) => ({
            sql: "i.provider=? AND i.native_id=?",
            params: [provider, id],
            exact: true,
          })),
          "OR",
        ),
      ],
      "AND",
    )
  let where = combine([{ sql: "m.deleted_at IS NULL", params: [], exact: true }, scope, expression], "AND")
  const joinedFrom =
    "FROM messages m JOIN chats c ON c.pk=m.chat_pk JOIN accounts ac ON ac.pk=m.account_pk LEFT JOIN identities i ON i.pk=m.sender_identity_pk"
  let baseFrom = joinedFrom
  const requiredText = (node: ResolvedNode): string | undefined => {
    if (node.kind === "predicate") return fragments.get(node)?.fragment.fts
    const required = node.clauses.filter(({ occur }) => occur === "must")
    const optional = node.clauses.filter(({ occur }) => occur === "should")
    if (required.length) {
      const parts = required.flatMap(({ node }) => requiredText(node) ?? [])
      return parts.length ? parts.map((part) => `(${part})`).join(" AND ") : undefined
    }
    const parts = optional.map(({ node }) => requiredText(node))
    return parts.length && parts.every((part) => part !== undefined)
      ? parts.map((part) => `(${part})`).join(" OR ")
      : undefined
  }
  const rankMatch = requiredText(execution.root)
  if (execution.chat && !rankMatch) {
    baseFrom =
      "FROM chats c JOIN accounts ac ON ac.pk=c.account_pk CROSS JOIN messages m LEFT JOIN identities i ON i.pk=m.sender_identity_pk"
    where = combine([{ sql: "m.chat_pk=c.pk", params: [], exact: true }, where], "AND")
  }
  const from = rankMatch ? baseFrom.replace("FROM messages m", "FROM message_words f CROSS JOIN messages m") : baseFrom
  if (rankMatch)
    where = combine(
      [
        {
          sql: "message_words MATCH ? AND f.rank MATCH 'bm25(1.0, 0.0)' AND m.pk=f.rowid",
          params: [`normalized_text : (${rankMatch})`],
          exact: true,
        },
        where,
      ],
      "AND",
    )
  const relevance = rankMatch ? "f.rank" : "NULL"
  const order = `${rankMatch && !execution.newest ? "f.rank," : ""}m.sent_at DESC, ac.provider, ac.native_id, c.native_id, m.native_id DESC`
  const leaves = [...fragments.values()]
  const exact = leaves.filter(({ test }) => test === undefined)
  const projection = exact.map(({ fragment }, index) => `coalesce(${fragment.sql},0) AS q${index}`).join(",")
  const projectionParams = exact.flatMap(({ fragment }) => fragment.params)
  const evaluate = (node: ResolvedNode, row: Record<string, unknown>, text: string, attachments: string[]): boolean => {
    if (node.kind === "predicate") {
      const leaf = fragments.get(node) as Leaf
      return leaf.test ? leaf.test(text, attachments) : Number(row[`q${exact.indexOf(leaf)}`]) === 1
    }
    const must = node.clauses.filter(({ occur }) => occur === "must")
    const should = node.clauses.filter(({ occur }) => occur === "should")
    const not = node.clauses.filter(({ occur }) => occur === "mustNot")
    return (
      (must.length
        ? must.every(({ node }) => evaluate(node, row, text, attachments))
        : should.length > 0 && should.some(({ node }) => evaluate(node, row, text, attachments))) &&
      not.every(({ node }) => !evaluate(node, row, text, attachments))
    )
  }
  if (leaves.every(({ test }) => !test)) {
    const rows = database
      .prepare(`SELECT m.pk AS pk, ${relevance} AS relevance ${from} WHERE ${where.sql} ORDER BY ${order} LIMIT ?`)
      .all(...where.params, execution.limit + 1)
    await new Promise<void>((resolve) => setImmediate(resolve))
    check()
    return {
      items: hitsByPk(
        context,
        rows.slice(0, execution.limit).map(({ pk }) => Number(pk)),
      ).map((hit, index) => ({
        ...hit,
        score: rows[index]?.relevance == null ? null : -Number(rows[index]?.relevance),
      })),
      hasMore: rows.length > execution.limit,
    }
  }
  const candidates = database
    .prepare(
      `SELECT m.pk AS pk, ${relevance} AS relevance, length(cast(m.text AS BLOB)) AS bytes ${from} WHERE ${where.sql} ORDER BY ${order} LIMIT ?`,
    )
    .all(...where.params, QUERY_LIMITS.candidates + 1)
  await new Promise<void>((resolve) => setImmediate(resolve))
  check()
  if (candidates.length > QUERY_LIMITS.candidates) exhausted("candidate rows")
  if (candidates.reduce((sum, row) => sum + Number(row.bytes), 0) > QUERY_LIMITS.bodyBytes) exhausted("body bytes")
  const found: number[] = []
  const scores = new Map(
    candidates.map((row) => [Number(row.pk), row.relevance == null ? null : -Number(row.relevance)]),
  )
  for (let offset = 0; offset < candidates.length; offset += 500) {
    if (offset > 0) await new Promise<void>((resolve) => setImmediate(resolve))
    check()
    const pks = candidates.slice(offset, offset + 500).map(({ pk }) => Number(pk))
    const rows = database
      .prepare(
        `SELECT m.pk AS pk,m.text AS body${projection ? `,${projection}` : ""},(SELECT json_group_array(att.kind) FROM attachments att WHERE att.message_pk=m.pk) AS attachment_kinds ${joinedFrom} WHERE m.pk IN (${pks.map(() => "?").join(",")})`,
      )
      .all(...projectionParams, ...pks)
    const byPk = new Map(rows.map((row) => [Number(row.pk), row]))
    for (const pk of pks) {
      check()
      const row = byPk.get(pk) as Record<string, unknown>
      const attachments: unknown = JSON.parse(String(row.attachment_kinds))
      if (evaluate(execution.root, row, String(row.body), Array.isArray(attachments) ? attachments.map(String) : []))
        found.push(pk)
      if (found.length > execution.limit) break
    }
    if (found.length > execution.limit) break
  }
  return {
    items: hitsByPk(context, found.slice(0, execution.limit)).map((hit, index) => ({
      ...hit,
      score: scores.get(found[index] as number) ?? null,
    })),
    hasMore: found.length > execution.limit,
  }
}
