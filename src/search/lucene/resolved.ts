import type { AccountKey } from "../../store/store.js"
import type { DateRange } from "./dates.js"
import type { Predicate, QueryNode, Span } from "./types.js"

export type ResolvedPredicate = Predicate & {
  resolution?: {
    chat?: { account: AccountKey; chatId: string }
    sender?: { provider: string; id: string }
    outgoing?: boolean
    date?: DateRange
    source?: string
  }
}
export type ResolvedNode =
  | ResolvedPredicate
  | { kind: "boolean"; clauses: { occur: "must" | "should" | "mustNot"; node: ResolvedNode }[]; span: Span }
export interface QueryExecution {
  root: ResolvedNode
  accounts: AccountKey[]
  chat?: { account: AccountKey; chatId: string }
  senders?: { provider: string; id: string }[]
  limit: number
  newest?: boolean
  signal?: AbortSignal
}
export const hasText = (node: QueryNode): boolean =>
  node.kind === "predicate" ? node.field === "text" : node.clauses.some(({ node }) => hasText(node))
