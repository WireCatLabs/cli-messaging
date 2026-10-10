import { normalize } from "../store/normalize.js"
import { implicitTextTerms, parseLucene } from "./lucene/parser.js"
import { walkQuery } from "./lucene/types.js"

export const words = (text: string) => normalize(text).match(/[\p{L}\p{N}]+/gu) ?? []
const scaffolding = new Set(
  words(
    "what which how many much who where when is are was were do does did can could should we the a an for of to under from in on at has have сколько какой какая какие какое кто кому кем где когда как что во по на в к с у через ли должен должна нужно идёт идет",
  ),
)
const questionWord =
  /\b(?:what|which|how|who|where|when)\b|(?:^|\s)(?:сколько|какой|какая|какие|какое|кто|кому|кем|где|когда|как|что)(?:\s|$)/iu
export function planQuestion(text: string, strict = false) {
  if (strict)
    return {
      changed: false,
      natural: false,
      queries: [text],
      scope: "",
      terms: words(text),
      rankingTerms: words(text),
      removed: [] as string[],
      aliases: [] as string[],
    }
  const prefix = words(text).slice(0, 2)
  const questionPrefix =
    [
      "what",
      "which",
      "how",
      "who",
      "where",
      "when",
      "сколько",
      "какои",
      "какая",
      "какие",
      "какое",
      "кто",
      "кому",
      "кем",
      "где",
      "когда",
      "как",
      "что",
    ].includes(prefix[0] ?? "") ||
    (["к", "во"].includes(prefix[0] ?? "") && ["кому", "сколько"].includes(prefix[1] ?? ""))
  const natural = questionWord.test(text) && (/\?/u.test(text) || questionPrefix)
  const cleaned = natural ? text.replace(/\?(?=\s*(?:(?:chat|from|date):[^\s]+\s*)*$)/u, "") : text
  const ast = parseLucene(cleaned)
  const predicates = walkQuery(ast.root)
  const textual = predicates.filter((p) => p.field === "text" || p.field === "exact")
  const fields = predicates.filter((p) => p.field !== "text" && p.field !== "exact")
  const scope = fields.map((p) => `${p.field}:${cleaned.slice(p.span.start, p.span.end)}`).join(" ")
  const bypass =
    strict ||
    !natural ||
    implicitTextTerms(cleaned).size === 0 ||
    textual.some((p) => p.operator !== "term" || p.field === "exact")
  if (bypass)
    return {
      changed: false,
      natural: false,
      queries: [text],
      scope,
      terms: textual.flatMap((p) => words(p.value)),
      rankingTerms: textual.flatMap((p) => words(p.value)),
      removed: [] as string[],
      aliases: [] as string[],
    }
  const original = textual.flatMap((p) => words(p.value))
  const removed = original.filter((w) => scaffolding.has(w))
  const terms = [...new Set(original.filter((w) => !scaffolding.has(w)))]
  if (!terms.length)
    return {
      changed: false,
      natural: true,
      queries: [text],
      scope,
      terms,
      rankingTerms: original,
      removed,
      aliases: [] as string[],
    }
  const alias = [...terms]
  const changes: string[] = []
  const replace = (from: string[], to: string) => {
    for (let i = 0; i < alias.length; i++)
      if (from.includes(alias[i] ?? "")) {
        changes.push(`${alias[i]} -> ${to}`)
        alias[i] = to
      }
  }
  if (terms.some((w) => ["refund", "euros", "euro", "money", "возврата", "возврат", "евро"].includes(w))) {
    replace(["returned", "refunded", "received"], "refund")
    replace(["вернули", "возвращено", "перечислено"], "возврат")
  }
  if (terms.some((w) => ["log", "logs", "retention", "backup", "логов", "логи", "хранение", "хранения"].includes(w))) {
    replace(["lifetime", "kept", "keep"], "retention")
    replace(["хранятся", "хранят", "хранить", "срок"], "хранение")
  }
  if (terms.includes("service") || terms.includes("build")) replace(["currently", "now"], "current")
  const render = (ws: string[]) => [...new Set(ws)].join(" ") + (scope ? ` ${scope}` : "")
  const queries = [...new Set([render(terms), render(alias)])].slice(0, 2)
  return { changed: true, natural: true, queries, scope, terms, rankingTerms: original, removed, aliases: changes }
}
