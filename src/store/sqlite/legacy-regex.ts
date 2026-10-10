import { isolatedRegex } from "../../search/legacy-regex.js"
import { exhausted, QUERY_LIMITS } from "../../search/lucene/types.js"
import type { MessageFilter, StoredHit } from "../store.js"
import { eq, inArray, sql } from "./drizzle/core.js"
import type { StoreContext } from "./open.js"
import { newestFirst } from "./reads.js"
import { accounts, chats, identities, messages } from "./schema.js"
import { hitsByPk, matching } from "./search.js"

export const findRegex = async (context: StoreContext, filter: MessageFilter) => {
  const pattern = filter.pattern
  if (!pattern) return { items: [] as StoredHit[], hasMore: false }
  const selected = context.orm
    .select({ pk: messages.id, bytes: sql<number>`length(cast(${messages.text} AS BLOB))` })
    .from(messages)
    .innerJoin(chats, eq(chats.id, messages.chatId))
    .leftJoin(identities, eq(identities.id, messages.senderIdentityId))
    .innerJoin(accounts, eq(accounts.id, messages.accountId))
    .where(matching(context, filter))
    .orderBy(...newestFirst)
    .limit(QUERY_LIMITS.candidates + 1)
    .all()
  if (selected.length > QUERY_LIMITS.candidates) exhausted("candidate rows")
  if (selected.reduce((sum, row) => sum + row.bytes, 0) > QUERY_LIMITS.bodyBytes) exhausted("body bytes")
  const ids = selected.map(({ pk }) => pk)
  const texts = new Map<number, string>()
  for (let at = 0; at < ids.length; at += 500) {
    const rows = context.orm
      .select({ pk: messages.id, text: messages.text })
      .from(messages)
      .where(inArray(messages.id, ids.slice(at, at + 500)))
      .all()
    for (const row of rows) texts.set(row.pk, row.text)
  }
  const matched = await isolatedRegex(
    pattern,
    ids.map((pk) => texts.get(pk) ?? ""),
    { signal: filter.signal },
  )
  return {
    items: hitsByPk(
      context,
      matched.slice(0, filter.limit).map((index) => ids[index] as number),
    ),
    hasMore: matched.length > filter.limit,
  }
}
