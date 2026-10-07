import { CliError } from "@leemour/cli-core"
import type { ChannelTagMatch } from "../../domain/channel-tags.js"
import type { AccountKey } from "../store.js"
import type { StoreContext } from "./open.js"
import { toIso } from "./values.js"

export interface ChatMetadata {
  chatId: string
  title: string | null
  username: string | null
  description: string | null
  fetchedAt: string
}

const chatPk = ({ database }: StoreContext, key: AccountKey, chatId: string) => {
  const row = database
    .prepare(
      "SELECT c.pk FROM chats c JOIN accounts a ON a.pk=c.account_pk WHERE a.provider=? AND a.native_id=? AND c.native_id=?",
    )
    .get(key.provider, key.account, chatId)
  if (!row) throw new CliError("not_found", "no stored chat with that id in this account")
  return Number(row.pk)
}

export const metadata = (context: StoreContext, key: AccountKey, chatId: string): ChatMetadata | undefined => {
  const row = context.database.prepare("SELECT * FROM chat_metadata WHERE chat_pk=?").get(chatPk(context, key, chatId))
  return row
    ? {
        chatId,
        title: row.title == null ? null : String(row.title),
        username: row.username == null ? null : String(row.username),
        description: row.description == null ? null : String(row.description),
        fetchedAt: toIso(Number(row.fetched_at)) as string,
      }
    : undefined
}

export const saveMetadata = (context: StoreContext, key: AccountKey, entry: Omit<ChatMetadata, "fetchedAt">) => {
  context.database
    .prepare(
      "INSERT INTO chat_metadata (chat_pk, title, username, description, fetched_at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(chat_pk) DO UPDATE SET title=excluded.title, username=excluded.username, description=excluded.description, fetched_at=excluded.fetched_at",
    )
    .run(chatPk(context, key, entry.chatId), entry.title, entry.username, entry.description, context.now())
  return metadata(context, key, entry.chatId) as ChatMetadata
}

/** Called inside the store's transaction: claims and effective search tags change together. */
export const replaceAutoTags = (
  context: StoreContext,
  key: AccountKey,
  chatId: string,
  algorithm: string,
  matches: ChannelTagMatch[],
) => {
  const pk = chatPk(context, key, chatId)
  const db = context.database
  db.prepare("DELETE FROM tags WHERE taggable_type='chat' AND taggable_pk=? AND manual=0").run(pk)
  db.prepare("DELETE FROM auto_tag_claims WHERE chat_pk=?").run(pk)
  const claim = db.prepare(
    "INSERT INTO auto_tag_claims (chat_pk, tag, algorithm, score, fields, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
  const tag = db.prepare(
    "INSERT INTO tags (taggable_type, taggable_pk, tag, created_at, manual) VALUES ('chat', ?, ?, ?, 0) ON CONFLICT DO NOTHING",
  )
  for (const match of matches) {
    claim.run(pk, match.tag, algorithm, match.score, JSON.stringify(match.fields), context.now())
    tag.run(pk, match.tag, context.now())
  }
}
