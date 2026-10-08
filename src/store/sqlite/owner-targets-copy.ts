import { canonicalReference, formatReference } from "../../domain/references.js"
import type { CacheDatabase } from "../driver.js"

const COPIED = "ownerTargetsCopied"

export const ownerTargetsToCopy = (database: CacheDatabase): boolean =>
  database.prepare("SELECT 1 FROM store_settings WHERE key = ?").get(COPIED) === undefined

/**
 * Moves labels from before version 27 to where the owner's own labels live: a person's, entity's or
 * task's from its account's `knowledge_targets` to `owner_targets`, a note's to the note, and a notes
 * subfolder's (a chat of the old `notes` provider) to its folder. Runs once — copying again would bring
 * back a label the owner removed since. The old rows stay for builds that still read them.
 */
export const copyIntoOwnerTargets = (database: CacheDatabase, now: () => number): void => {
  const at = now()
  const target = database.prepare(
    "INSERT INTO owner_targets (reference, folder_id, folder_path, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
  )
  const targetPk = database.prepare("SELECT pk FROM owner_targets WHERE reference = ?")
  const label = database.prepare(
    "INSERT INTO tags (taggable_type, taggable_pk, tag, created_at, manual) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
  )
  const labelsOf = database.prepare(
    "SELECT tag, created_at, manual FROM tags WHERE taggable_type = ? AND taggable_pk = ?",
  )
  const copyLabels = (fromType: string, fromPk: number, toType: string, toPk: number) => {
    for (const row of labelsOf.all(fromType, fromPk))
      label.run(toType, toPk, String(row.tag), Number(row.created_at), Number(row.manual))
  }
  const ownerTarget = (reference: string, folder?: { id: string; path: string }) => {
    target.run(reference, folder?.id ?? null, folder?.path ?? null, at)
    return Number(targetPk.get(reference)?.pk)
  }

  for (const row of database
    .prepare("SELECT pk, type, reference FROM knowledge_targets WHERE type IN ('person', 'entity', 'task', 'note')")
    .all()) {
    if (row.type === "note") {
      const note = database.prepare("SELECT pk FROM notes WHERE id = ?").get(String(row.reference))
      if (note) copyLabels("knowledge", Number(row.pk), "note", Number(note.pk))
      continue
    }
    copyLabels("knowledge", Number(row.pk), "owner", ownerTarget(`${String(row.type)}:${String(row.reference)}`))
  }

  for (const row of database
    .prepare(
      "SELECT c.pk, c.native_id AS chat, f.id AS folder FROM chats c JOIN note_folders f ON f.account_pk = c.account_pk " +
        "WHERE EXISTS (SELECT 1 FROM tags t WHERE t.taggable_type = 'chat' AND t.taggable_pk = c.pk)",
    )
    .all()) {
    const chat = String(row.chat)
    const path = chat === "." ? null : chat
    const reference = canonicalReference(formatReference({ type: "folder", id: String(row.folder), path }))
    copyLabels("chat", Number(row.pk), "owner", ownerTarget(reference, { id: String(row.folder), path: path ?? "" }))
  }

  database.prepare("INSERT INTO store_settings (key, value, at) VALUES (?, '1', ?)").run(COPIED, at)
}
