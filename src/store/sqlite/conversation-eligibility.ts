import type { QueryExecution } from "../../search/lucene/resolved.js"
import type { AccountKey } from "../store.js"
import { queryMessagePks } from "./lucene.js"
import type { StoreContext } from "./open.js"

export interface ConversationEligibility {
  conversations: string[]
  chats: { account: AccountKey; chat: string }[]
}

export const conversationEligibility = async (
  context: StoreContext,
  execution: QueryExecution,
): Promise<ConversationEligibility> => {
  if (!execution.accounts.length) return { conversations: [], chats: [] }
  const pks = JSON.stringify(await queryMessagePks(context, execution))
  const conversations = context.database
    .prepare(`SELECT DISTINCT cv.pk AS id FROM conversation_messages cm
    JOIN conversations cv ON cv.pk=cm.conversation_pk
    JOIN conversation_state cs ON cs.chat_pk=cv.chat_pk AND cs.current_build=cv.build
    WHERE cm.message_pk IN (SELECT value FROM json_each(?))`)
    .all(pks)
    .map(({ id }) => String(id))
  const chats = context.database
    .prepare(`SELECT DISTINCT ac.provider, ac.native_id AS account, ch.native_id AS chat
    FROM messages m JOIN chats ch ON ch.pk=m.chat_pk JOIN accounts ac ON ac.pk=m.account_pk
    WHERE m.pk IN (SELECT value FROM json_each(?))`)
    .all(pks)
    .map((row) => ({
      account: { provider: String(row.provider), account: String(row.account) },
      chat: String(row.chat),
    }))
  return { conversations, chats }
}
