import { CliError } from "@leemour/cli-core"
import { formatLocator } from "../../domain/locator.js"
import type { Id } from "../../domain/models.js"
import type { TagType } from "../../domain/tags.js"
import type { SqlValue } from "../driver.js"
import type { AccountKey } from "../store.js"
import type { StoreContext } from "./open.js"
import { toIso } from "./values.js"

/** What a tag labels: a chat or a message of the account, or a person of its messenger. */
export type TagTarget =
  | { type: "chat"; chatId: Id }
  | { type: "contact"; personId: Id }
  | { type: "message"; chatId: Id; messageId: Id }

export interface StoredTag {
  tag: string
  type: TagType
  chatId?: Id
  chatTitle?: string | null
  personId?: Id
  name?: string | null
  messageId?: Id
  locator?: string
  sources?: ("manual" | "auto")[]
  createdAt: string
}

export interface TagFilter {
  source?: "manual" | "auto"
  tag?: string
  type?: TagType
}

export const targetPk = ({ database }: StoreContext, key: AccountKey, target: TagTarget): number => {
  const found =
    target.type === "contact"
      ? database
          .prepare("SELECT pk FROM identities WHERE provider=? AND native_id=?")
          .get(key.provider, target.personId)
      : target.type === "chat"
        ? database
            .prepare(
              "SELECT c.pk FROM chats c JOIN accounts a ON a.pk=c.account_pk WHERE a.provider=? AND a.native_id=? AND c.native_id=?",
            )
            .get(key.provider, key.account, target.chatId)
        : database
            .prepare(
              "SELECT m.pk FROM messages m JOIN chats c ON c.pk=m.chat_pk JOIN accounts a ON a.pk=c.account_pk " +
                "WHERE a.provider=? AND a.native_id=? AND c.native_id=? AND m.native_id=? AND m.deleted_at IS NULL",
            )
            .get(key.provider, key.account, target.chatId, target.messageId)
  if (found === undefined) {
    const what =
      target.type === "contact"
        ? `person ${target.personId}`
        : target.type === "chat"
          ? `chat ${target.chatId}`
          : `message ${target.messageId} in chat ${target.chatId}`
    throw new CliError("not_found", `the local store holds no ${what}`)
  }
  return Number(found.pk)
}

/** The tags it did not have before, in the order given. */
export const addTags = (context: StoreContext, pk: number, type: TagType | "note", tags: string[]): string[] => {
  const insert = context.database.prepare(
    "INSERT INTO tags (taggable_type, taggable_pk, tag, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
  )
  const at = context.now()
  return tags.filter((tag) => {
    const added = insert.run(type, pk, tag, at).changes > 0
    context.database
      .prepare("UPDATE tags SET manual=1 WHERE taggable_type=? AND taggable_pk=? AND tag=? AND manual=0")
      .run(type, pk, tag)
    return added
  })
}

/** The tags it had, in the order given. */
export const removeTags = (
  { database }: StoreContext,
  pk: number,
  type: TagType | "note",
  tags: string[],
  source?: "manual" | "auto",
): string[] => {
  const remove = database.prepare("DELETE FROM tags WHERE taggable_type=? AND taggable_pk=? AND tag=?")
  return tags.filter((tag) => {
    const row = database
      .prepare("SELECT manual FROM tags WHERE taggable_type=? AND taggable_pk=? AND tag=?")
      .get(type, pk, tag)
    const automatic =
      type === "chat" &&
      database.prepare("SELECT 1 AS held FROM auto_tag_claims WHERE chat_pk=? AND tag=?").get(pk, tag)
    if (source === "manual") {
      if (!row || !Number(row.manual)) return false
      if (automatic)
        database
          .prepare("UPDATE tags SET manual=0 WHERE taggable_type=? AND taggable_pk=? AND tag=?")
          .run(type, pk, tag)
      else remove.run(type, pk, tag)
      return true
    }
    if (type === "chat") database.prepare("DELETE FROM auto_tag_claims WHERE chat_pk=? AND tag=?").run(pk, tag)
    if (source === "auto") {
      if (!automatic) return false
      if (!Number(row?.manual)) remove.run(type, pk, tag)
      return true
    }
    return remove.run(type, pk, tag).changes > 0
  })
}

export const tagsOf = ({ database }: StoreContext, key: AccountKey, filter: TagFilter): StoredTag[] => {
  const tagged = filter.tag === undefined ? "" : " AND t.tag=?"
  const parts: { type: TagType; sql: string; params: SqlValue[] }[] = [
    {
      type: "chat",
      sql:
        "SELECT t.tag, t.taggable_type AS type, t.created_at, c.native_id AS chat_id, c.title AS chat_title, " +
        "NULL AS person_id, NULL AS name, NULL AS message_id, t.manual, t.taggable_pk AS target_pk FROM tags t JOIN chats c ON c.pk=t.taggable_pk " +
        "JOIN accounts a ON a.pk=c.account_pk WHERE t.taggable_type='chat' AND a.provider=? AND a.native_id=?",
      params: [key.provider, key.account],
    },
    {
      type: "contact",
      sql:
        "SELECT t.tag, t.taggable_type AS type, t.created_at, NULL AS chat_id, NULL AS chat_title, " +
        "i.native_id AS person_id, i.name AS name, NULL AS message_id, t.manual, t.taggable_pk AS target_pk " +
        "FROM tags t JOIN identities i ON i.pk=t.taggable_pk WHERE t.taggable_type='contact' AND i.provider=?",
      params: [key.provider],
    },
    {
      type: "message",
      sql:
        "SELECT t.tag, t.taggable_type AS type, t.created_at, c.native_id AS chat_id, c.title AS chat_title, " +
        "NULL AS person_id, NULL AS name, m.native_id AS message_id, t.manual, t.taggable_pk AS target_pk " +
        "FROM tags t JOIN messages m ON m.pk=t.taggable_pk JOIN chats c ON c.pk=m.chat_pk " +
        "JOIN accounts a ON a.pk=c.account_pk WHERE t.taggable_type='message' AND a.provider=? AND a.native_id=?",
      params: [key.provider, key.account],
    },
  ]
  const chosen = parts.filter(({ type }) => filter.type === undefined || filter.type === type)
  const rows = database
    .prepare(`${chosen.map(({ sql }) => sql + tagged).join(" UNION ALL ")} ORDER BY 1, 2, 3, 4, 6, 8`)
    .all(...chosen.flatMap(({ params }) => (filter.tag === undefined ? params : [...params, filter.tag])))
  const result = rows.map((row): StoredTag => {
    const type = String(row.type) as TagType
    const chatId = row.chat_id == null ? undefined : String(row.chat_id)
    const messageId = row.message_id == null ? undefined : String(row.message_id)
    const automatic =
      type === "chat" &&
      database
        .prepare("SELECT 1 AS held FROM auto_tag_claims WHERE chat_pk=? AND tag=?")
        .get(Number(row.target_pk), String(row.tag))
    return {
      ...(automatic ? { sources: (Number(row.manual) ? ["manual", "auto"] : ["auto"]) as ("manual" | "auto")[] } : {}),
      tag: String(row.tag),
      type,
      ...(type === "contact"
        ? { personId: String(row.person_id), name: row.name == null ? null : String(row.name) }
        : { chatId, chatTitle: row.chat_title == null ? null : String(row.chat_title) }),
      ...(type === "message" && chatId !== undefined && messageId !== undefined
        ? { messageId, locator: formatLocator({ ...key, chat: chatId, message: messageId }) }
        : {}),
      createdAt: toIso(Number(row.created_at)) as string,
    }
  })
  return filter.source === undefined
    ? result
    : result.filter((entry) => (entry.sources ?? ["manual"]).includes(filter.source as "manual" | "auto"))
}
