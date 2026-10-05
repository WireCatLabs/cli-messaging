import { NOT_FILES } from "../../domain/attachments.js"
import type { Id } from "../../domain/models.js"
import type { CacheDatabase } from "../driver.js"
import { normalize } from "../normalize.js"
import type { StoreContext } from "./open.js"
import { inBatch } from "./search-index.js"

export type TextOrigin = "extracted" | "agent"

/** One stored file attachment that extraction may read. */
export interface FileAttachment {
  pk: number
  chatId: Id
  messageId: Id
  /** From 0, as stored. */
  position: number
  kind: string
  name: string | null
  mime: string | null
  size: number | null
  localPath: string | null
  /** What an earlier run left, when it read this file. */
  read: { origin: TextOrigin; bytes: number | null; error: string | null } | null
}

export interface AttachmentTextEntry {
  text: string
  origin: TextOrigin
  extractor: string
  contentSha256?: string | null
  bytes?: number | null
  error?: string | null
}

const NOT_FILE_LIST = [...NOT_FILES].map((kind) => `'${kind}'`).join(",")

/**
 * File attachments of live messages, newest first, below `beforePk`. An agent's text is final, so its
 * attachments are never offered again.
 */
export const fileAttachments = (
  { database }: StoreContext,
  accountKey: number,
  { chatKey, beforePk, limit }: { chatKey?: number; beforePk?: number; limit: number },
): FileAttachment[] =>
  database
    .prepare(
      `SELECT att.pk, c.native_id AS chat_id, m.native_id AS message_id, att.position, att.kind, att.name, att.mime,
         att.size, att.local_path, t.origin, t.bytes AS read_bytes, t.error
       FROM attachments att
       JOIN messages m ON m.pk = att.message_pk
       JOIN chats c ON c.pk = m.chat_pk
       LEFT JOIN attachment_texts t ON t.attachment_pk = att.pk
       WHERE m.account_pk = ? AND m.deleted_at IS NULL AND att.kind NOT IN (${NOT_FILE_LIST})
         AND (t.origin IS NULL OR t.origin <> 'agent')
         ${chatKey === undefined ? "" : "AND m.chat_pk = ?"} AND att.pk < ?
       ORDER BY att.pk DESC LIMIT ?`,
    )
    .all(accountKey, ...(chatKey === undefined ? [] : [chatKey]), beforePk ?? Number.MAX_SAFE_INTEGER, limit)
    .map((row) => ({
      pk: Number(row.pk),
      chatId: String(row.chat_id),
      messageId: String(row.message_id),
      position: Number(row.position),
      kind: String(row.kind),
      name: row.name == null ? null : String(row.name),
      mime: row.mime == null ? null : String(row.mime),
      size: row.size == null ? null : Number(row.size),
      localPath: row.local_path == null ? null : String(row.local_path),
      read:
        row.origin == null
          ? null
          : {
              origin: String(row.origin) as TextOrigin,
              bytes: row.read_bytes == null ? null : Number(row.read_bytes),
              error: row.error == null ? null : String(row.error),
            },
    }))

/** Where a downloaded attachment was saved, after `messages download` recorded it. */
export const localPathOf = ({ database }: StoreContext, attachmentPk: number): string | null => {
  const row = database.prepare("SELECT local_path FROM attachments WHERE pk = ?").get(attachmentPk)
  return row?.local_path == null ? null : String(row.local_path)
}

/** An extraction never replaces what an agent wrote; an agent replaces anything. */
export const keepText = (
  { database, now }: StoreContext,
  attachmentPk: number,
  entry: AttachmentTextEntry,
): boolean => {
  const { changes } = database
    .prepare(
      `INSERT INTO attachment_texts
         (attachment_pk, text, normalized_text, origin, extractor, content_sha256, bytes, error, written_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (attachment_pk) DO UPDATE SET text = excluded.text, normalized_text = excluded.normalized_text,
         origin = excluded.origin, extractor = excluded.extractor, content_sha256 = excluded.content_sha256,
         bytes = excluded.bytes, error = excluded.error, written_at = excluded.written_at
       ${entry.origin === "agent" ? "" : "WHERE attachment_texts.origin <> 'agent'"}`,
    )
    .run(
      attachmentPk,
      entry.text,
      normalize(entry.text),
      entry.origin,
      entry.extractor,
      entry.contentSha256 ?? null,
      entry.bytes ?? null,
      entry.error ?? null,
      now(),
    )
  return Number(changes) > 0
}

/**
 * For `store reindex`: the normalized copies follow the current normalizer, then the word index is
 * emptied and filled from them in one transaction — the table is small next to the messages.
 */
export const resetAttachmentWords = (database: CacheDatabase): number => {
  const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'attachment_words'").get()
  if (!exists) return 0
  return inBatch(database, () => {
    const update = database.prepare("UPDATE attachment_texts SET normalized_text = ? WHERE attachment_pk = ?")
    for (const row of database.prepare("SELECT attachment_pk, text, normalized_text FROM attachment_texts").all()) {
      const normalized = normalize(String(row.text))
      if (normalized !== row.normalized_text) update.run(normalized, Number(row.attachment_pk))
    }
    database.exec("INSERT INTO attachment_words (attachment_words) VALUES ('delete-all')")
    const { changes } = database
      .prepare(
        "INSERT INTO attachment_words (rowid, normalized_text) SELECT attachment_pk, normalized_text FROM attachment_texts WHERE normalized_text <> ''",
      )
      .run()
    return Number(changes)
  })
}
