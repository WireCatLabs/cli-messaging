import { CliError } from "@wirecat/cli-core"
import { formatReference } from "../../domain/references.js"
import type { AccountKey } from "../store.js"
import { ulid } from "../ulid.js"
import { resolvePersonLinks } from "./notes.js"
import type { StoreContext } from "./open.js"
import { toIso } from "./values.js"

export interface PrivateContactNote {
  id: string
  personId: string
  text: string
  revision: number
  createdAt: string
  updatedAt: string
}

export interface PrivateContact {
  personId: string
  alias: string | null
  notes: PrivateContactNote[]
}

const required = ({ database }: StoreContext, key: AccountKey, personId: string) => {
  const row = database
    .prepare(
      "SELECT a.pk AS account_pk, i.pk AS identity_pk FROM accounts a " +
        "JOIN account_identities ai ON ai.account_pk=a.pk JOIN identities i ON i.pk=ai.identity_pk " +
        "WHERE a.provider=? AND a.native_id=? AND i.provider=? AND i.native_id=?",
    )
    .get(key.provider, key.account, key.provider, personId)
  if (!row) throw new CliError("not_found", "this account has no stored identity with that id")
  return { account: Number(row.account_pk), identity: Number(row.identity_pk) }
}

const noteOf = (row: Record<string, unknown>, personId: string): PrivateContactNote => ({
  id: String(row.id),
  personId,
  text: String(row.text),
  revision: Number(row.revision),
  createdAt: toIso(Number(row.created_at)) as string,
  updatedAt: toIso(Number(row.updated_at)) as string,
})

const contactRef = (key: AccountKey, personId: string) =>
  formatReference({ type: "contact", provider: key.provider, id: personId })

/** A contact's notes are the owner's notes about that identity, whichever account wrote them. */
const NOTES_ABOUT =
  "SELECT n.* FROM notes n JOIN links l ON l.from_ref = 'note:' || n.id AND l.kind = 'about' " +
  "WHERE l.to_ref = ? AND n.source = 'internal' AND n.deleted_at IS NULL"

export const privateContact = (context: StoreContext, key: AccountKey, personId: string): PrivateContact => {
  const { account, identity } = required(context, key, personId)
  const alias = context.database
    .prepare("SELECT alias FROM contact_aliases WHERE account_pk=? AND identity_pk=?")
    .get(account, identity)?.alias
  const notes = context.database
    .prepare(`${NOTES_ABOUT} ORDER BY n.created_at, n.id`)
    .all(contactRef(key, personId))
    .map((row) => noteOf(row, personId))
  return { personId, alias: alias == null ? null : String(alias), notes }
}

export const setAlias = (context: StoreContext, key: AccountKey, personId: string, alias: string | null) => {
  const { account, identity } = required(context, key, personId)
  const value = alias?.trim() ?? null
  if (value !== null && (value.length === 0 || value.length > 200))
    throw new CliError("validation_error", "an alias takes 1–200 characters")
  context.database
    .prepare(
      "INSERT INTO contact_aliases (account_pk, identity_pk, alias, alias_folded, updated_at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(account_pk, identity_pk) DO UPDATE SET alias=excluded.alias, alias_folded=excluded.alias_folded, updated_at=excluded.updated_at",
    )
    .run(account, identity, value, value?.toLowerCase() ?? null, context.now())
  resolvePersonLinks(context.database, [value])
  return { personId, alias: value }
}

const noteText = (text: string) => {
  const value = text.trim()
  if (!value || value.length > 100_000) throw new CliError("validation_error", "a note takes 1–100000 characters")
  return value
}

export const addNote = (context: StoreContext, key: AccountKey, personId: string, text: string) => {
  required(context, key, personId)
  const at = context.now()
  const id = ulid(at)
  context.database
    .prepare("INSERT INTO notes (id, source, text, created_at, updated_at) VALUES (?, 'internal', ?, ?, ?)")
    .run(id, noteText(text), at, at)
  context.database
    .prepare(
      "INSERT INTO links (id, from_ref, to_ref, kind, origin, confirmed, created_at) VALUES (?, ?, ?, 'about', 'owner', 1, ?)",
    )
    .run(ulid(at), `note:${id}`, contactRef(key, personId), at)
  return privateContact(context, key, personId).notes.find((note) => note.id === id) as PrivateContactNote
}

export const note = (context: StoreContext, key: AccountKey, personId: string, id: string): PrivateContactNote => {
  const found = privateContact(context, key, personId).notes.find((entry) => entry.id === id)
  if (!found) throw new CliError("not_found", "no private note with that id on this contact")
  return found
}

export const editNote = (
  context: StoreContext,
  key: AccountKey,
  personId: string,
  id: string,
  text: string,
  revision: number,
) => {
  const held = note(context, key, personId, id)
  const changed = context.database
    .prepare("UPDATE notes SET text=?, updated_at=?, revision=revision+1 WHERE id=? AND revision=?")
    .run(noteText(text), context.now(), id, revision).changes
  if (!changed) throw new CliError("validation_error", "the note changed; read its current revision before editing")
  context.database
    .prepare("INSERT INTO note_revisions (note_pk, text, captured_at) SELECT pk, ?, ? FROM notes WHERE id=?")
    .run(held.text, context.now(), id)
  return note(context, key, personId, id)
}

export const removeNote = (context: StoreContext, key: AccountKey, personId: string, id: string) => {
  note(context, key, personId, id)
  context.database.prepare("DELETE FROM notes WHERE id=?").run(id)
  return { id, personId, removed: true }
}
