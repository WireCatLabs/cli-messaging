import { CliError } from "@leemour/cli-core"
import { formatLocator } from "../../domain/locator.js"
import type { Message, Page } from "../../domain/models.js"
import type { MessageFilter, StoredHit } from "../store.js"
import { alias, and, desc, eq, inArray, isNull, lte, type SQL, sql } from "./drizzle/core.js"
import type { StoreContext } from "./open.js"
import { before, MESSAGE_FIELDS, type MessageRow, newestFirst, toMessages } from "./reads.js"
import { accounts, chats, identities, messages } from "./schema.js"

const CHUNK = 500

const HIT_FIELDS = {
  ...MESSAGE_FIELDS,
  chatTitle: sql<string | null>`${chats.title}`.as("chat_title"),
  provider: sql<string>`${accounts.provider}`.as("provider"),
  accountNativeId: sql<string>`${accounts.nativeId}`.as("account_native_id"),
}

type HitRow = MessageRow & { chatTitle: string | null; provider: string; accountNativeId: string }

/** Every word of three characters or more, found anywhere inside the text; a trigram index cannot match a shorter one. */
const wordsOf = (text: string): string => {
  const words = (text.match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => [...word].length >= 3)
  if (words.length === 0) throw new CliError("validation_error", "search needs a word of three letters or more")
  return words.map((word) => `"${word}"`).join(" ")
}

/** What `find` keeps, as one condition. */
export const matching = (
  context: StoreContext,
  {
    provider,
    account,
    accounts: within,
    senders,
    together = false,
    text,
    pattern,
    chatId,
    perChat = false,
  }: Omit<MessageFilter, "limit">,
): SQL | undefined => {
  const trimmed = pattern ? undefined : text?.trim()
  if (trimmed !== undefined && [...trimmed].length < 3) {
    throw new CliError("validation_error", "search needs at least three characters")
  }
  if (pattern && perChat) throw new CliError("validation_error", "a pattern search is not per chat")
  if (!trimmed && !pattern && !senders?.length) {
    throw new CliError("validation_error", "say what to find: some text, or who wrote it")
  }
  const scopeProvider = account?.provider ?? provider
  if (within && scopeProvider === undefined) {
    throw new CliError("validation_error", "a read across accounts names their provider")
  }
  const ids = senders?.length ? [...new Set(senders)] : undefined
  return and(
    isNull(messages.deletedAt),
    trimmed
      ? sql`${messages.pk} IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ${wordsOf(trimmed)})`
      : undefined,
    scopeProvider === undefined ? undefined : eq(accounts.provider, scopeProvider),
    account ? eq(accounts.nativeId, account.account) : undefined,
    within ? inArray(accounts.nativeId, within) : undefined,
    chatId === undefined ? undefined : eq(chats.nativeId, chatId),
    ids ? and(eq(identities.provider, accounts.provider), inArray(identities.nativeId, ids)) : undefined,
    ids && together ? inArray(messages.chatPk, everyoneWrote(context, ids, scopeProvider)) : undefined,
  )
}

/** The chats where every one of `ids` has a message — the outer row's provider when no scope names one. */
const everyoneWrote = ({ orm }: StoreContext, ids: string[], scopeProvider: string | undefined) => {
  const written = alias(messages, "m2")
  const writer = alias(identities, "i2")
  return orm
    .select({ chatPk: written.chatPk })
    .from(written)
    .innerJoin(writer, eq(writer.pk, written.senderIdentityPk))
    .where(
      and(
        isNull(written.deletedAt),
        eq(writer.provider, scopeProvider ?? identities.provider),
        inArray(writer.nativeId, ids),
      ),
    )
    .groupBy(written.chatPk)
    .having(sql`count(DISTINCT ${writer.nativeId}) = ${ids.length}`)
}

const chatRank = sql<number>`row_number() OVER (PARTITION BY ${messages.chatPk} ORDER BY ${messages.sentAt} DESC, ${messages.pk} DESC)`

const selectHits = ({ orm }: StoreContext) =>
  orm
    .select(HIT_FIELDS)
    .from(messages)
    .innerJoin(chats, eq(chats.pk, messages.chatPk))
    .leftJoin(identities, eq(identities.pk, messages.senderIdentityPk))
    .innerJoin(accounts, eq(accounts.pk, messages.accountPk))

const selectRanked = ({ orm }: StoreContext) =>
  orm
    .select({ ...HIT_FIELDS, chatRank: chatRank.as("chat_rank") })
    .from(messages)
    .innerJoin(chats, eq(chats.pk, messages.chatPk))
    .leftJoin(identities, eq(identities.pk, messages.senderIdentityPk))
    .innerJoin(accounts, eq(accounts.pk, messages.accountPk))

/** The plain search, newest first; exported so a test can read the plan SQLite makes of it. */
export const newestHits = (context: StoreContext, where: SQL | undefined, wanted: number) =>
  selectHits(context)
    .where(where)
    .orderBy(...newestFirst)
    .limit(wanted)

export const find = (context: StoreContext, filter: MessageFilter): Page<StoredHit> => {
  const { limit, pattern, perChat = false } = filter
  const where = matching(context, filter)
  const rows: HitRow[] = pattern
    ? scan(context, where, pattern, limit + 1)
    : perChat
      ? perChatNewest(context, where, limit + 1)
      : newestHits(context, where, limit + 1).all()
  const page = perChat
    ? rows.filter((row) => (row as HitRow & { chatRank: number }).chatRank <= limit)
    : rows.slice(0, limit)
  const found = toMessages(context, page)
  return {
    items: page.map((row, index) => {
      const message = found[index] as Message
      return {
        ...message,
        chatTitle: row.chatTitle,
        locator: formatLocator({
          provider: row.provider,
          account: row.accountNativeId,
          chat: message.chatId,
          message: message.id,
        }),
      }
    }),
    hasMore: rows.length > page.length,
  }
}

const perChatNewest = (context: StoreContext, where: SQL | undefined, wanted: number) => {
  const ranked = selectRanked(context).where(where).as("ranked")
  return context.orm
    .select()
    .from(ranked)
    .where(lte(ranked.chatRank, wanted))
    .orderBy(desc(ranked.sentAt), desc(ranked.pk))
    .all()
}

/** Newest first, a chunk at a time, until `wanted` rows match or the rows run out. */
const scan = (context: StoreContext, where: SQL | undefined, pattern: RegExp, wanted: number): HitRow[] => {
  const found: HitRow[] = []
  let last: HitRow | undefined
  while (found.length < wanted) {
    const chunk = selectHits(context)
      .where(and(where, last ? before(last.sentAt, last.pk) : undefined))
      .orderBy(...newestFirst)
      .limit(CHUNK)
      .all()
    for (const row of chunk) {
      pattern.lastIndex = 0
      if (pattern.test(row.text)) found.push(row)
      if (found.length === wanted) break
    }
    last = chunk.at(-1)
    if (chunk.length < CHUNK || !last) break
  }
  return found
}
