import { basename } from "node:path"
import { formatLocator } from "../../domain/locator.js"
import { formatReference } from "../../domain/references.js"
import type { CacheDatabase } from "../driver.js"
import { ulid } from "../ulid.js"

type Row = Record<string, unknown>

const WATERMARK = "notesCopiedThroughMessage"

const titleAndBody = (text: string): { title: string | null; body: string } => {
  const split = text.indexOf("\n\n")
  return split < 0 ? { title: text || null, body: "" } : { title: text.slice(0, split), body: text.slice(split + 2) }
}

const watermark = (database: CacheDatabase): number =>
  Number(database.prepare("SELECT value FROM store_settings WHERE key = ?").get(WATERMARK)?.value ?? 0)

/**
 * Whether a build from before version 25 left anything the owner's tables do not hold yet. Every check
 * is an index lookup or reads a table of the owner's own records, so it runs on each open.
 */
export const notesToCopy = (database: CacheDatabase): boolean =>
  Number(
    database
      .prepare(
        "SELECT EXISTS (SELECT 1 FROM accounts a WHERE a.provider = 'notes' AND NOT EXISTS (SELECT 1 FROM note_folders f WHERE f.account_pk = a.pk)) " +
          "OR EXISTS (SELECT 1 FROM note_folders f JOIN chats c ON c.account_pk = f.account_pk JOIN messages m ON m.chat_pk = c.pk WHERE m.pk > ?) " +
          "OR EXISTS (SELECT 1 FROM annotations a WHERE NOT EXISTS (SELECT 1 FROM notes n WHERE n.id = a.uid)) " +
          "OR EXISTS (SELECT 1 FROM knowledge_relations r WHERE NOT EXISTS (SELECT 1 FROM links l WHERE l.id = r.uid OR (l.from_ref = r.from_ref AND l.to_ref = r.to_ref AND l.kind = r.kind))) " +
          "OR EXISTS (SELECT 1 FROM knowledge_entities e WHERE NOT EXISTS (SELECT 1 FROM entities n WHERE n.id = e.uid)) AS pending",
      )
      .get(watermark(database))?.pending,
  ) === 1

/** Removing a copied note or link removes its source row too, or the next open would copy it back. */
export const forgetCopied = (database: CacheDatabase, { note, link }: { note?: string; link?: string }): void => {
  if (note !== undefined) database.prepare("DELETE FROM annotations WHERE uid = ?").run(note)
  if (link !== undefined) database.prepare("DELETE FROM knowledge_relations WHERE uid = ?").run(link)
}

/**
 * Copies what builds before version 25 wrote — notes stored as messages of provider `notes`,
 * annotations, relations, entities — into the owner's tables. It only adds what is missing, so it runs
 * after the migration and again whenever an older build has written since; the old rows are never
 * touched. A notes folder's absolute path stops being an id: it waits in `note_folders.pending_path`
 * for the notes tool to move it into this computer's config.
 */
export const copyIntoNotes = (database: CacheDatabase, now: () => number): void => {
  const at = now()
  const insertNote = database.prepare(
    "INSERT INTO notes (id, source, folder_id, path, title, text, revision, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING pk",
  )
  const insertRevision = database.prepare("INSERT INTO note_revisions (note_pk, text, captured_at) VALUES (?, ?, ?)")
  const insertTag = database.prepare(
    "INSERT INTO tags (taggable_type, taggable_pk, tag, created_at, manual) VALUES ('note', ?, ?, ?, ?) ON CONFLICT DO NOTHING",
  )
  const insertLink = database.prepare(
    "INSERT INTO links (id, from_ref, to_ref, kind, origin, role, evidence, provenance, confirmed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )

  for (const account of database
    .prepare(
      "SELECT a.pk, a.native_id, a.name FROM accounts a WHERE a.provider = 'notes' AND NOT EXISTS (SELECT 1 FROM note_folders f WHERE f.account_pk = a.pk)",
    )
    .all()) {
    const path = String(account.native_id)
    database
      .prepare(
        "INSERT INTO note_folders (id, name, format, pending_path, account_pk, created_at) VALUES (?, ?, 'obsidian', ?, ?, ?)",
      )
      .run(
        `fld_${ulid(at)}`,
        account.name == null ? basename(path) : String(account.name),
        path,
        Number(account.pk),
        at,
      )
  }

  const after = watermark(database)
  const messages = database
    .prepare(
      "SELECT m.pk, m.native_id, m.text, m.sent_at, m.edited_at, m.deleted_at, f.id AS folder FROM messages m " +
        "JOIN chats c ON c.pk = m.chat_pk JOIN note_folders f ON f.account_pk = c.account_pk WHERE m.pk > ? ORDER BY m.pk",
    )
    .all(after)
  for (const message of messages) {
    const { title, body } = titleAndBody(String(message.text))
    const created = insertNote.get(
      ulid(Number(message.sent_at)),
      "file",
      String(message.folder),
      String(message.native_id),
      title,
      body,
      1,
      Number(message.sent_at),
      Number(message.edited_at ?? message.sent_at),
      message.deleted_at == null ? null : Number(message.deleted_at),
    )
    if (!created) continue
    const pk = Number(created.pk)
    for (const revision of database
      .prepare("SELECT text, captured_at FROM message_revisions WHERE message_pk = ?")
      .all(Number(message.pk)))
      insertRevision.run(pk, String(revision.text), Number(revision.captured_at))
    for (const tag of database
      .prepare("SELECT tag, created_at, manual FROM tags WHERE taggable_type = 'message' AND taggable_pk = ?")
      .all(Number(message.pk)))
      insertTag.run(pk, String(tag.tag), Number(tag.created_at), Number(tag.manual))
  }
  const highest = database.prepare("SELECT max(pk) AS pk FROM messages").get()?.pk
  if (highest != null && Number(highest) > after)
    database
      .prepare(
        "INSERT INTO store_settings (key, value, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at",
      )
      .run(WATERMARK, String(highest), at)

  const noteByLocator = new Map<string, string>()
  const notesOfMessages = () => {
    if (noteByLocator.size > 0) return noteByLocator
    for (const row of database
      .prepare(
        "SELECT n.id, a.native_id AS account, c.native_id AS chat, m.native_id AS message FROM notes n " +
          "JOIN note_folders f ON f.id = n.folder_id JOIN accounts a ON a.pk = f.account_pk " +
          "JOIN chats c ON c.account_pk = a.pk JOIN messages m ON m.chat_pk = c.pk AND m.native_id = n.path",
      )
      .all())
      noteByLocator.set(
        formatLocator({
          provider: "notes",
          account: String(row.account),
          chat: String(row.chat),
          message: String(row.message),
        }),
        String(row.id),
      )
    return noteByLocator
  }

  const referenceOf = (row: Row): string => {
    const reference = String(row.reference)
    const provider = String(row.provider)
    switch (row.type) {
      case "message": {
        const note = reference.startsWith("msg:notes/") ? notesOfMessages().get(reference) : undefined
        return note === undefined ? reference : `note:${note}`
      }
      case "chat":
        return formatReference({ type: "chat", provider, account: String(row.account), chat: reference })
      case "contact":
        return formatReference({ type: "contact", provider, id: reference })
      default:
        return `${String(row.type)}:${reference}`
    }
  }

  const annotations = database
    .prepare(
      "SELECT * FROM (SELECT a.*, t.type, t.reference, ac.provider, ac.native_id AS account FROM annotations a JOIN knowledge_targets t ON t.pk = a.target_pk JOIN accounts ac ON ac.pk = a.account_pk WHERE a.target_type = 'source' " +
        "UNION ALL SELECT a.*, 'contact' AS type, i.native_id AS reference, i.provider, ac.native_id AS account FROM annotations a JOIN identities i ON i.pk = a.target_pk JOIN accounts ac ON ac.pk = a.account_pk WHERE a.target_type = 'contact') " +
        "WHERE NOT EXISTS (SELECT 1 FROM notes n WHERE n.id = uid) ORDER BY created_at, uid",
    )
    .all()
  for (const annotation of annotations) {
    insertNote.get(
      String(annotation.uid),
      "internal",
      null,
      null,
      null,
      String(annotation.text),
      Number(annotation.revision),
      Number(annotation.created_at),
      Number(annotation.updated_at),
      null,
    )
    insertLink.run(
      ulid(Number(annotation.created_at)),
      `note:${String(annotation.uid)}`,
      referenceOf(annotation),
      "about",
      "owner",
      null,
      null,
      null,
      1,
      Number(annotation.created_at),
    )
  }

  const relations = database
    .prepare(
      "SELECT * FROM knowledge_relations r WHERE NOT EXISTS (SELECT 1 FROM links l WHERE l.id = r.uid) " +
        "AND NOT EXISTS (SELECT 1 FROM links l WHERE l.from_ref = r.from_ref AND l.to_ref = r.to_ref AND l.kind = r.kind) ORDER BY created_at, uid",
    )
    .all()
  const related = new Set<string>()
  for (const relation of relations) {
    const key = `${String(relation.from_ref)}\n${String(relation.to_ref)}\n${String(relation.kind)}`
    if (related.has(key)) continue
    related.add(key)
    const confirmed = Number(relation.confirmed)
    insertLink.run(
      String(relation.uid),
      String(relation.from_ref),
      String(relation.to_ref),
      String(relation.kind),
      confirmed === 1 ? "owner" : "suggested",
      relation.role == null ? null : String(relation.role),
      relation.evidence == null ? null : String(relation.evidence),
      relation.provenance == null ? null : String(relation.provenance),
      confirmed,
      Number(relation.created_at),
    )
  }

  database.exec(
    "INSERT INTO entities (id, kind, name, created_at) SELECT uid, kind, name, created_at FROM knowledge_entities WHERE true ON CONFLICT DO NOTHING",
  )

  const retarget = database.prepare("UPDATE knowledge_targets SET type = 'note', reference = ? WHERE pk = ?")
  for (const target of database
    .prepare("SELECT pk, reference FROM knowledge_targets WHERE type = 'message' AND reference LIKE 'msg:notes/%'")
    .all()) {
    const note = notesOfMessages().get(String(target.reference))
    if (note !== undefined) retarget.run(note, Number(target.pk))
  }
}
