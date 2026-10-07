import { CliError } from "@leemour/cli-core"
import type { AccountKey } from "../store.js"
import { ulid } from "../ulid.js"
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
  id: String(row.uid),
  personId,
  text: String(row.text),
  revision: Number(row.revision),
  createdAt: toIso(Number(row.created_at)) as string,
  updatedAt: toIso(Number(row.updated_at)) as string,
})

export const privateContact = (context: StoreContext, key: AccountKey, personId: string): PrivateContact => {
  const { account, identity } = required(context, key, personId)
  const alias = context.database
    .prepare("SELECT alias FROM contact_aliases WHERE account_pk=? AND identity_pk=?")
    .get(account, identity)?.alias
  const notes = context.database
    .prepare(
      "SELECT * FROM annotations WHERE account_pk=? AND ((target_type='contact' AND target_pk=?) OR (target_type='source' AND target_pk IN (SELECT pk FROM knowledge_targets WHERE account_pk=? AND type='contact' AND reference=?))) ORDER BY created_at, uid",
    )
    .all(account, identity, account, personId)
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
  return { personId, alias: value }
}

const noteText = (text: string) => {
  const value = text.trim()
  if (!value || value.length > 100_000) throw new CliError("validation_error", "a note takes 1–100000 characters")
  return value
}

export const addNote = (context: StoreContext, key: AccountKey, personId: string, text: string) => {
  const { account, identity } = required(context, key, personId)
  const at = context.now()
  const id = ulid(at)
  context.database
    .prepare(
      "INSERT INTO annotations (uid, account_pk, target_type, target_pk, text, revision, created_at, updated_at, authored_by) " +
        "VALUES (?, ?, 'contact', ?, ?, 1, ?, ?, 'owner')",
    )
    .run(id, account, identity, noteText(text), at, at)
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
  const { account, identity } = required(context, key, personId)
  note(context, key, personId, id)
  const changed = context.database
    .prepare(
      "UPDATE annotations SET text=?, updated_at=?, revision=revision+1 " +
        "WHERE uid=? AND account_pk=? AND ((target_type='contact' AND target_pk=?) OR (target_type='source' AND target_pk IN (SELECT pk FROM knowledge_targets WHERE account_pk=? AND type='contact' AND reference=?))) AND revision=?",
    )
    .run(noteText(text), context.now(), id, account, identity, account, personId, revision).changes
  if (!changed) throw new CliError("validation_error", "the note changed; read its current revision before editing")
  return note(context, key, personId, id)
}

export const removeNote = (context: StoreContext, key: AccountKey, personId: string, id: string) => {
  const { account, identity } = required(context, key, personId)
  note(context, key, personId, id)
  context.database
    .prepare(
      "DELETE FROM annotations WHERE uid=? AND account_pk=? AND ((target_type='contact' AND target_pk=?) OR (target_type='source' AND target_pk IN (SELECT pk FROM knowledge_targets WHERE account_pk=? AND type='contact' AND reference=?)))",
    )
    .run(id, account, identity, account, personId)
  return { id, personId, removed: true }
}
