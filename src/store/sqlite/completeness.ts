import type { Id } from "../../domain/models.js"
import type { StoreContext } from "./open.js"

/** The sync state that marks a chat fetched back to its first message (phase 2 plan S10). */
export const historyStartKey = (chatId: Id): string => `history_start:${chatId}`

export interface ChatCompleteness {
  chatId: Id
  /** `unknown` when nothing ever fetched the chat's history: an empty answer then proves nothing. */
  state: "complete" | "partial" | "unknown"
  /** Holds the newest message the chat list knows of; `null` when the list gave no time. */
  upToDate: boolean | null
  /** More than one stretch held, with history missing between them. */
  gaps: boolean
  reachesStart: boolean
}

/** Three facts per chat (NEED-455 A): the newest held against the chat list's, the stretches, and the start reached. */
export const chatCompleteness = ({ database }: StoreContext, accountKey: number, chatIds: Id[]): ChatCompleteness[] => {
  if (chatIds.length === 0) return []
  return database
    .prepare(
      `SELECT c.native_id AS chat, c.last_message_at AS newest,
         (SELECT max(m.sent_at) FROM messages m WHERE m.chat_pk = c.pk AND m.deleted_at IS NULL) AS held,
         (SELECT count(*) FROM sync_ranges r WHERE r.chat_pk = c.pk) AS stretches,
         EXISTS (SELECT 1 FROM sync_state s WHERE s.account_pk = c.account_pk AND s.key = 'history_start:' || c.native_id)
           AS start
       FROM chats c WHERE c.account_pk = ? AND c.native_id IN (${chatIds.map(() => "?").join(", ")})`,
    )
    .all(accountKey, ...chatIds)
    .map((row): ChatCompleteness => {
      const stretches = Number(row.stretches)
      const reachesStart = Number(row.start) === 1
      const upToDate = row.newest === null ? null : row.held !== null && Number(row.held) >= Number(row.newest)
      const gaps = stretches > 1
      const fetched = stretches > 0 || reachesStart
      return {
        chatId: String(row.chat),
        state: !fetched ? "unknown" : upToDate !== false && !gaps && reachesStart ? "complete" : "partial",
        upToDate,
        gaps,
        reachesStart,
      }
    })
}
