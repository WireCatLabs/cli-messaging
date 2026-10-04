import {
  type Operator,
  type Predicate,
  QUERY_LIMITS,
  type QueryAst,
  type QueryNode,
  queryError,
  type Span,
  walkQuery,
} from "./types.js"

export const FIELD_VERSION = 1
const terms: Operator[] = ["term", "phrase"]
export const QUERY_FIELDS = [
  {
    name: "text",
    example: "invoice",
    index: "message_words",
    aliases: [],
    type: "tokens",
    operators: ["term", "phrase", "wildcard", "regex"],
    normalization: "NFKD/marks/NFC/lowercase v1",
    support: "A1",
  },
  {
    name: "body",
    example: "body:/.*invoice.*/",
    index: "messages.text / bounded postfilter",
    aliases: [],
    type: "keyword",
    operators: ["term", "phrase", "wildcard", "regex"],
    normalization: "raw, case-sensitive",
    support: "A1",
  },
  {
    name: "from",
    example: 'from:"Alice Synthetic"',
    index: "identities / sender index",
    aliases: [],
    type: "person",
    operators: terms,
    normalization: "account-scoped resolution",
    support: "A1",
  },
  {
    name: "chat",
    example: 'chat:"Work fixture"',
    index: "chats / message time index",
    aliases: [],
    type: "chat",
    operators: terms,
    normalization: "account-scoped resolution",
    support: "A1",
  },
  {
    name: "date",
    example: "date:[2026-01-01 TO 2026-02-01}",
    index: "messages.sent_at",
    aliases: [],
    type: "timestamp",
    operators: [...terms, "range"],
    normalization: "ISO/calendar timezone; today, yesterday, 30m/2h/7d ago",
    support: "A1",
  },
  {
    name: "kind",
    example: "kind:private",
    index: "chats.kind / peerKind metadata",
    aliases: [],
    type: "enum",
    operators: terms,
    normalization: "lowercase",
    support: "A1",
    values: ["private", "saved", "bot", "service", "group", "channel", "unknown"],
  },
  {
    name: "has",
    example: "has:file",
    index: "attachments / messages_fts links",
    aliases: [],
    type: "enum",
    operators: terms,
    normalization: "lowercase",
    support: "A1",
    values: [
      "attachment",
      "link",
      "file",
      "photo",
      "image",
      "video",
      "audio",
      "voice",
      "sticker",
      "contact",
      "location",
      "poll",
    ],
  },
  {
    name: "topic",
    example: "chat:7 AND topic:42",
    index: "messages.thread_native_id",
    aliases: [],
    type: "id",
    operators: terms,
    normalization: "string id, one chat required",
    support: "A1",
  },
  {
    name: "in",
    example: "in:bots",
    index: "accounts.provider",
    aliases: [],
    type: "source",
    operators: terms,
    normalization: "lowercase provider/account class",
    support: "A1",
  },
  {
    name: "preset",
    example: "preset:secret",
    index: "bounded local candidate detector",
    aliases: [],
    type: "enum",
    operators: terms,
    normalization: "versioned candidate detector",
    support: "A1",
    values: [
      "password",
      "code",
      "api-key",
      "secret",
      "card",
      "bank",
      "passport",
      "phone",
      "email",
      "telegram-link",
      "url",
      "contact",
      "location",
    ],
  },
  {
    name: "filename",
    example: "filename:*.pdf",
    index: "attachments.name / bounded postfilter",
    aliases: [],
    type: "keyword",
    operators: [...terms, "wildcard", "regex"],
    normalization: "NFKD/marks/NFC/lowercase v1, whole name",
    support: "A2",
  },
  {
    name: "mime",
    example: 'mime:"application/pdf" OR mime:image',
    index: "attachments.mime / bounded postfilter",
    aliases: [],
    type: "keyword",
    operators: [...terms, "wildcard"],
    normalization: "lowercase; a value without / matches the first part; only where the messenger reports a type",
    support: "A2",
  },
  {
    name: "size",
    example: "size>10MB",
    index: "attachments.size",
    aliases: [],
    type: "bytes",
    operators: [...terms, "range"],
    normalization: "bytes; KB/MB/GB are 1024-based",
    support: "A2",
  },
  {
    name: "tag",
    example: "tag:work",
    index: "planned",
    aliases: [],
    type: "local-tag",
    operators: terms,
    normalization: "planned",
    support: "planned",
  },
] as const

const UNITS: Record<string, number> = {
  "": 1,
  b: 1,
  k: 1024,
  kb: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
}
export const parseBytes = (value: string, span: Span): number => {
  const [, amount, unit] = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/iu.exec(value.trim()) ?? []
  const scale = UNITS[unit?.toLowerCase() ?? ""]
  if (amount === undefined || scale === undefined) queryError("invalid_size", span, "use bytes or KB/MB/GB, e.g. 10MB")
  return Math.round(Number(amount) * scale)
}

export const validatePredicate = (node: Predicate): void => {
  const field = QUERY_FIELDS.find(({ name }) => name === node.field)
  if (!field && ["after", "before"].includes(node.field))
    queryError("legacy_date_field", node.span, "use --language legacy or standard date ranges")
  if (!field) queryError("unknown_field", node.span, "use a field from the search field reference")
  if (field.support === "planned")
    queryError("unsupported_field", node.span, `${field.name} is planned for the next archive phase`)
  if (!(field.operators as readonly string[]).includes(node.operator))
    queryError("unsupported_operator", node.span, `${field.name} takes ${field.operators.join(", ")}`)
  if (node.value === "" && !["text", "body"].includes(node.field)) queryError("missing_value", node.span)
  if ("values" in field && !field.values.includes(node.value.toLowerCase() as never))
    queryError("unknown_value", node.span, `${field.name} takes ${field.values.join(", ")}`)
  if (field.name === "size")
    for (const bound of node.operator === "range" ? [node.value, node.upper] : [node.value])
      if (bound !== undefined && bound !== "*") parseBytes(bound, node.span)
  if (field.name === "topic" && !/^\d+$/u.test(node.value))
    queryError("invalid_topic", node.span, "use a thread id in one chat")
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const validSpan = (value: unknown): value is Span =>
  record(value) &&
  Number.isInteger(value.start) &&
  Number.isInteger(value.end) &&
  Number(value.start) >= 0 &&
  Number(value.end) >= Number(value.start) &&
  Number(value.end) <= QUERY_LIMITS.bytes
export const validateAst = (input: unknown): QueryAst => {
  const failure = { start: 0, end: 0 }
  if (!record(input) || input.version !== 1 || input.language !== "lucene-v1")
    queryError("unsupported_version", failure)
  let count = 0
  let bytes = 0
  const read = (value: unknown, depth: number): QueryNode => {
    if (++count > QUERY_LIMITS.nodes || depth > QUERY_LIMITS.depth) queryError("query_limit", failure)
    if (!record(value) || !validSpan(value.span)) queryError("invalid_ast", failure)
    const span = { start: value.span.start, end: value.span.end }
    if (value.kind === "boolean") {
      if (!Array.isArray(value.clauses) || value.clauses.length === 0 || value.clauses.length > QUERY_LIMITS.nodes)
        queryError("invalid_ast", span)
      const clauses = value.clauses.map((clause: unknown) => {
        if (!record(clause) || !["must", "should", "mustNot"].includes(String(clause.occur)))
          queryError("invalid_ast", span)
        const occur = clause.occur as "must" | "should" | "mustNot"
        return { occur, node: read(clause.node, depth + 1) }
      })
      return { kind: "boolean", clauses, span }
    }
    if (
      value.kind !== "predicate" ||
      typeof value.field !== "string" ||
      typeof value.value !== "string" ||
      !["term", "phrase", "wildcard", "regex", "range"].includes(String(value.operator))
    )
      queryError("invalid_ast", span)
    if (value.value.length + value.field.length > QUERY_LIMITS.bytes) queryError("query_limit", span)
    bytes += new TextEncoder().encode(value.value).length + value.field.length
    if (bytes > QUERY_LIMITS.bytes) queryError("query_limit", span)
    const operator = value.operator as Operator
    if (
      operator === "range" &&
      (typeof value.upper !== "string" ||
        typeof value.lowerInclusive !== "boolean" ||
        typeof value.upperInclusive !== "boolean")
    )
      queryError("invalid_ast", span)
    if (typeof value.upper === "string") {
      if (value.upper.length > QUERY_LIMITS.bytes) queryError("query_limit", span)
      bytes += new TextEncoder().encode(value.upper).length
      if (bytes > QUERY_LIMITS.bytes) queryError("query_limit", span)
    }
    const node: Predicate = {
      kind: "predicate",
      field: value.field,
      operator,
      value: value.value,
      span,
      ...(operator === "range"
        ? {
            upper: String(value.upper),
            lowerInclusive: Boolean(value.lowerInclusive),
            upperInclusive: Boolean(value.upperInclusive),
          }
        : {}),
    }
    validatePredicate(node)
    return node
  }
  const root = read(input.root, 1)
  return { version: 1, language: "lucene-v1", root }
}
export const validateFields = (ast: QueryAst): QueryAst => {
  for (const node of walkQuery(ast.root)) validatePredicate(node)
  return ast
}

export const QUERY_OPERATORS = [
  {
    name: "term",
    example: "invoice",
    semantics: "Точное совпадение анализированного текста; без автоматического prefix",
  },
  { name: "phrase", example: '"invoice paid"', semantics: "Последовательность анализированных слов" },
  {
    name: "implicit AND",
    example: "invoice paid",
    semantics: "Оба clauses обязательны; adjacency группируется по upstream grammar",
  },
  { name: "AND / &&", example: "alpha AND beta", semantics: "Оба условия обязательны" },
  { name: "OR / ||", example: "alpha OR beta", semantics: "Любой optional clause, если нет required clause" },
  {
    name: "NOT / ! / -",
    example: "alpha NOT beta",
    semantics: "Исключить beta; чистое отрицание не выбирает весь архив",
  },
  { name: "+", example: "+alpha OR beta", semantics: "alpha обязателен, beta optional" },
  { name: "group", example: "(alpha OR beta) gamma", semantics: "Скобки фиксируют grouping" },
  { name: "field group", example: "from:(alice OR bob)", semantics: "Поле наследуется внутри группы" },
  { name: "field equality", example: "kind=group", semantics: "Стандартный синоним записи kind:group" },
  {
    name: "range",
    example: "date:[2026-01-01 TO 2026-02-01}",
    semantics: "Inclusive [ ], exclusive { }, смешанные границы и *",
  },
  { name: "comparison", example: "date>=2026-01-01", semantics: "Стандартный typed open range" },
  { name: "wildcard", example: "text:invo*", semantics: "Полный term; * — любое число символов, ? — один" },
  { name: "regex", example: "text:/pass(port)?/", semantics: "Полный term; bounded subset Lucene RegExp" },
  {
    name: "fuzzy / proximity",
    example: "invoice~1",
    semantics: "unsupported_operator; используйте legacy discovery либо точные слова",
  },
  { name: "boost / minimum / intervals", example: "invoice^2", semantics: "unsupported_operator" },
] as const
