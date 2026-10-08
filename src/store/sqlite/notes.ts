import { CliError } from "@leemour/cli-core"
import { canonicalReference } from "../../domain/references.js"
import { normalizeTag } from "../../domain/tags.js"
import type { CacheDatabase, CacheStatement } from "../driver.js"
import { fold } from "../normalize.js"
import { ulid } from "../ulid.js"
import type { NoteSearch } from "./note-search.js"
import { forgetCopied } from "./notes-copy.js"
import type { StoreContext } from "./open.js"

export const NOTE_FORMATS = ["obsidian", "markdown"] as const
export const LINK_KINDS = ["links-to", "about", "member-of", "related-to", "assigned-to"] as const
export const LINK_ORIGINS = ["file", "owner", "suggested"] as const
export const ENTITY_KINDS = ["organization", "family", "project", "group"] as const

export interface NoteFolder {
  id: string
  name: string
  format: (typeof NOTE_FORMATS)[number]
  /** A path from before version 25, waiting for the notes tool to move it into this computer's config. */
  pendingPath: string | null
  createdAt: string
}

export interface Note {
  id: string
  source: "file" | "internal"
  folderId: string | null
  path: string | null
  title: string | null
  text: string
  frontMatter: unknown
  contentHash: string | null
  revision: number
  exportPath: string | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export interface Link {
  id: string
  from: string
  /** `null` while the link names nobody the store knows, or more than one. */
  to: string | null
  kind: (typeof LINK_KINDS)[number]
  anchor: string | null
  origin: (typeof LINK_ORIGINS)[number]
  targetText: string | null
  role: string | null
  evidence: string | null
  provenance: string | null
  confirmed: boolean
  createdAt: string
}

export interface LinkInput {
  from: string
  to?: string
  targetText?: string
  kind: Link["kind"]
  anchor?: string
  origin?: Link["origin"]
  role?: string
  evidence?: string
  provenance?: string
  confirmed?: boolean
}

export interface FileNoteInput {
  folderId: string
  path: string
  title: string | null
  text: string
  frontMatter?: unknown
  contentHash?: string | null
}

export interface Entity {
  id: string
  kind: (typeof ENTITY_KINDS)[number]
  name: string
  createdAt: string
}

export interface NotesStore extends NoteSearch {
  addFolder(input: { name: string; format?: NoteFolder["format"] }): Promise<NoteFolder>
  folders(): Promise<NoteFolder[]>
  /** Answers the folder's pending path and forgets it, so it is handed over once. */
  claimFolderPath(id: string): Promise<{ id: string; path: string | null }>
  saveFileNote(input: FileNoteInput): Promise<{ note: Note; changed: boolean }>
  /** Moves a file note to a new path in its folder, keeping its id, links and tags; a gone note at `to` is dropped. */
  renameFileNote(folderId: string, from: string, to: string): Promise<Note>
  /** Marks the folder's notes at these paths deleted; answers how many were live. */
  deleteFileNotes(folderId: string, paths: string[]): Promise<number>
  addNote(input: { text: string; title?: string; about?: string[] }): Promise<Note>
  note(id: string): Promise<Note>
  notes(options?: {
    folderId?: string
    source?: Note["source"]
    about?: string
    search?: string
    limit?: number
    offset?: number
  }): Promise<{ items: Note[]; hasMore: boolean }>
  editNote(id: string, text: string, revision: number): Promise<Note>
  removeNote(id: string): Promise<{ id: string; removed: true }>
  addLink(input: LinkInput): Promise<Link>
  links(options?: { from?: string; to?: string; unresolved?: boolean }): Promise<Link[]>
  removeLink(id: string): Promise<{ id: string; removed: true }>
  /** The links a file states, replacing what its last import stated; links the owner added stay. */
  replaceFileLinks(noteId: string, links: Omit<LinkInput, "from" | "origin">[]): Promise<Link[]>
  /**
   * The tags a file states, replacing what its last import stated. A tag the owner added stays, even when
   * the file stops stating it; a file tag the owner also added becomes the owner's.
   */
  replaceFileTags(noteId: string, tags: string[]): Promise<NoteTag[]>
  noteTags(noteId: string): Promise<NoteTag[]>
  /** Tries every unresolved link against the people known now; answers how many it resolved. */
  resolveLinks(): Promise<number>
  addEntity(kind: Entity["kind"], name: string): Promise<Entity>
  entities(): Promise<Entity[]>
}

export interface NoteTag {
  tag: string
  origin: "file" | "owner"
}

type Row = Record<string, unknown>
const iso = (value: unknown) => new Date(Number(value)).toISOString()

const textOf = (text: string, what: string, max = 100_000, allowEmpty = false) => {
  const value = text.trim()
  if ((!value && !allowEmpty) || value.length > max)
    throw new CliError("validation_error", `${what} takes ${allowEmpty ? 0 : 1}–${max} characters`)
  return value
}

const oneOf = <T extends string>(value: string, allowed: readonly T[], what: string): T => {
  if (!allowed.includes(value as T)) throw new CliError("validation_error", `${what} is one of ${allowed.join(", ")}`)
  return value as T
}

/** What a link's written target is matched by: case, accents and a leading `@` do not count. */
export const targetKey = (text: string): string => fold(text).trim().replace(/^@/, "")

export const noteOf = (row: Row): Note => ({
  id: String(row.id),
  source: row.source as Note["source"],
  folderId: row.folder_id == null ? null : String(row.folder_id),
  path: row.path == null ? null : String(row.path),
  title: row.title == null ? null : String(row.title),
  text: String(row.text),
  frontMatter: row.front_matter == null ? null : JSON.parse(String(row.front_matter)),
  contentHash: row.content_hash == null ? null : String(row.content_hash),
  revision: Number(row.revision),
  exportPath: row.export_path == null ? null : String(row.export_path),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  deletedAt: row.deleted_at == null ? null : iso(row.deleted_at),
})

export const linkOf = (row: Row): Link => ({
  id: String(row.id),
  from: String(row.from_ref),
  to: row.to_ref == null ? null : String(row.to_ref),
  kind: row.kind as Link["kind"],
  anchor: row.anchor == null ? null : String(row.anchor),
  origin: row.origin as Link["origin"],
  targetText: row.target_text == null ? null : String(row.target_text),
  role: row.role == null ? null : String(row.role),
  evidence: row.evidence == null ? null : String(row.evidence),
  provenance: row.provenance == null ? null : String(row.provenance),
  confirmed: Number(row.confirmed) === 1,
  createdAt: iso(row.created_at),
})

const folderOf = (row: Row): NoteFolder => ({
  id: String(row.id),
  name: String(row.name),
  format: row.format as NoteFolder["format"],
  pendingPath: row.pending_path == null ? null : String(row.pending_path),
  createdAt: iso(row.created_at),
})

const entityOf = (row: Row): Entity => ({
  id: String(row.id),
  kind: row.kind as Entity["kind"],
  name: String(row.name),
  createdAt: iso(row.created_at),
})

/** The people a written name points at: by name or username of any identity, or by a local alias. */
const personsNamed = (database: CacheDatabase, key: string): Set<string> => {
  const found = new Set<string>()
  if (key.length >= 3) {
    const rows = database
      .prepare(
        "SELECT i.name, i.username, p.uid FROM identities_fts f JOIN identities i ON i.pk = f.rowid " +
          "JOIN identity_links il ON il.identity_pk = i.pk JOIN persons p ON p.pk = il.person_pk WHERE identities_fts MATCH ?",
      )
      .all(`"${key.replaceAll('"', '""')}"`)
    for (const row of rows) {
      const names = [row.name, row.username].filter((one) => one != null).map((one) => targetKey(String(one)))
      if (names.includes(key)) found.add(String(row.uid))
    }
  }
  const aliases = database
    .prepare(
      "SELECT ca.alias, p.uid FROM contact_aliases ca JOIN identity_links il ON il.identity_pk = ca.identity_pk " +
        "JOIN persons p ON p.pk = il.person_pk WHERE ca.alias IS NOT NULL",
    )
    .all()
  for (const row of aliases) if (targetKey(String(row.alias)) === key) found.add(String(row.uid))
  return found
}

const resolveKey = (database: CacheDatabase, key: string): number => {
  const people = personsNamed(database, key)
  if (people.size !== 1) return 0
  return database
    .prepare("UPDATE links SET to_ref = ? WHERE to_ref IS NULL AND target_folded = ?")
    .run(`person:${[...people][0]}`, key).changes
}

const unresolvedChecks = new WeakMap<CacheDatabase, CacheStatement>()

/**
 * Called in the write that creates or renames a person, or gives them an alias: one indexed lookup,
 * and only a name some note is waiting for costs more.
 */
export const resolvePersonLinks = (database: CacheDatabase, names: (string | null | undefined)[]): void => {
  const keys = [...new Set(names.filter((name): name is string => !!name?.trim()).map(targetKey))]
  if (keys.length === 0) return
  let check = unresolvedChecks.get(database)
  if (!check) {
    check = database.prepare("SELECT 1 FROM links WHERE to_ref IS NULL AND target_folded = ? LIMIT 1")
    unresolvedChecks.set(database, check)
  }
  for (const key of keys) if (check.get(key)) resolveKey(database, key)
}

export const notesStoreOver = ({ database, now }: StoreContext): Omit<NotesStore, keyof NoteSearch> => {
  const atomic = <T>(body: () => T): T => {
    database.exec("BEGIN IMMEDIATE")
    try {
      const result = body()
      database.exec("COMMIT")
      return result
    } catch (error) {
      database.exec("ROLLBACK")
      throw error
    }
  }
  const noteRow = (id: string) => {
    const row = database.prepare("SELECT * FROM notes WHERE id = ?").get(id)
    if (!row) throw new CliError("not_found", `no note ${id} in the local store`)
    return row
  }
  const tagsOfNote = (pk: number): NoteTag[] =>
    database
      .prepare("SELECT tag, manual FROM tags WHERE taggable_type = 'note' AND taggable_pk = ? ORDER BY tag")
      .all(pk)
      .map((row) => ({ tag: String(row.tag), origin: Number(row.manual) === 1 ? "owner" : "file" }))
  const folderRow = (id: string) => {
    const row = database.prepare("SELECT * FROM note_folders WHERE id = ?").get(id)
    if (!row) throw new CliError("not_found", `no notes folder ${id} in the local store`)
    return row
  }
  const insertLink = (input: LinkInput): Link => {
    const kind = oneOf(input.kind, LINK_KINDS, "a link's kind")
    const origin = oneOf(input.origin ?? "owner", LINK_ORIGINS, "a link's origin")
    const from = canonicalReference(input.from)
    const to = input.to === undefined ? null : canonicalReference(input.to)
    const targetText = input.targetText === undefined ? null : textOf(input.targetText, "a link's target", 500)
    if (to === null && targetText === null) throw new CliError("validation_error", "a link needs a target")
    if (to !== null) {
      const existing = database
        .prepare("SELECT * FROM links WHERE from_ref = ? AND to_ref = ? AND kind = ? AND anchor IS ?")
        .get(from, to, kind, input.anchor ?? null)
      if (existing) return linkOf(existing)
    }
    const at = now()
    const id = ulid(at)
    database
      .prepare(
        "INSERT INTO links (id, from_ref, to_ref, kind, anchor, origin, target_text, target_folded, role, evidence, provenance, confirmed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        from,
        to,
        kind,
        input.anchor ?? null,
        origin,
        targetText,
        targetText === null ? null : targetKey(targetText),
        input.role === undefined ? null : textOf(input.role, "a role", 200),
        input.evidence === undefined ? null : textOf(input.evidence, "evidence", 2000),
        input.provenance === undefined ? null : textOf(input.provenance, "provenance", 2000),
        input.confirmed === false ? 0 : 1,
        at,
      )
    if (to === null && targetText !== null) resolveKey(database, targetKey(targetText))
    return linkOf(database.prepare("SELECT * FROM links WHERE id = ?").get(id) as Row)
  }
  const bounded = (limit = 100, offset = 0) => {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500 || !Number.isInteger(offset) || offset < 0)
      throw new CliError("validation_error", "limit takes 1–500 and offset 0 or more")
    return { limit, offset }
  }

  return {
    addFolder: async ({ name, format = "obsidian" }) => {
      const at = now()
      const id = `fld_${ulid(at)}`
      database
        .prepare("INSERT INTO note_folders (id, name, format, created_at) VALUES (?, ?, ?, ?)")
        .run(id, textOf(name, "a folder's name", 200), oneOf(format, NOTE_FORMATS, "a folder's format"), at)
      return folderOf(folderRow(id))
    },
    folders: async () => database.prepare("SELECT * FROM note_folders ORDER BY name, id").all().map(folderOf),
    claimFolderPath: async (id) =>
      atomic(() => {
        const path = folderRow(id).pending_path
        database.prepare("UPDATE note_folders SET pending_path = NULL WHERE id = ?").run(id)
        return { id, path: path == null ? null : String(path) }
      }),
    saveFileNote: async (input) =>
      atomic(() => {
        folderRow(input.folderId)
        const path = textOf(input.path, "a note's path", 4096)
        const text = textOf(input.text, "a note's text", 200_000, true)
        const frontMatter = input.frontMatter == null ? null : JSON.stringify(input.frontMatter)
        const at = now()
        const found = database.prepare("SELECT * FROM notes WHERE folder_id = ? AND path = ?").get(input.folderId, path)
        if (!found) {
          const id = ulid(at)
          database
            .prepare(
              "INSERT INTO notes (id, source, folder_id, path, title, text, front_matter, content_hash, created_at, updated_at) VALUES (?, 'file', ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(id, input.folderId, path, input.title, text, frontMatter, input.contentHash ?? null, at, at)
          return { note: noteOf(noteRow(id)), changed: true }
        }
        const same =
          found.text === text &&
          (found.title ?? null) === input.title &&
          (found.front_matter ?? null) === frontMatter &&
          (found.content_hash ?? null) === (input.contentHash ?? null) &&
          found.deleted_at == null
        if (same) return { note: noteOf(found), changed: false }
        if (found.text !== text)
          database
            .prepare("INSERT INTO note_revisions (note_pk, text, captured_at) VALUES (?, ?, ?)")
            .run(Number(found.pk), String(found.text), at)
        database
          .prepare(
            "UPDATE notes SET title = ?, text = ?, front_matter = ?, content_hash = ?, revision = revision + ?, updated_at = ?, deleted_at = NULL WHERE pk = ?",
          )
          .run(
            input.title,
            text,
            frontMatter,
            input.contentHash ?? null,
            found.text === text ? 0 : 1,
            at,
            Number(found.pk),
          )
        return { note: noteOf(noteRow(String(found.id))), changed: true }
      }),
    renameFileNote: async (folderId, from, to) =>
      atomic(() => {
        folderRow(folderId)
        const target = textOf(to, "a note's path", 4096)
        const found = database
          .prepare("SELECT id FROM notes WHERE folder_id = ? AND path = ? AND deleted_at IS NULL")
          .get(folderId, from)
        if (!found) throw new CliError("not_found", `no live note at ${from} in folder ${folderId}`)
        const taken = database
          .prepare("SELECT pk, deleted_at FROM notes WHERE folder_id = ? AND path = ?")
          .get(folderId, target)
        if (taken && taken.deleted_at == null)
          throw new CliError("validation_error", `a live note is already at ${target} in folder ${folderId}`)
        if (taken) database.prepare("DELETE FROM notes WHERE pk = ?").run(Number(taken.pk))
        database.prepare("UPDATE notes SET path = ?, updated_at = ? WHERE id = ?").run(target, now(), String(found.id))
        return noteOf(noteRow(String(found.id)))
      }),
    deleteFileNotes: async (folderId, paths) =>
      atomic(() => {
        folderRow(folderId)
        const mark = database.prepare(
          "UPDATE notes SET deleted_at = ?, text = '' WHERE folder_id = ? AND path = ? AND deleted_at IS NULL",
        )
        return paths.reduce((sum, path) => sum + mark.run(now(), folderId, path).changes, 0)
      }),
    addNote: async ({ text, title, about = [] }) =>
      atomic(() => {
        const at = now()
        const id = ulid(at)
        const targets = about.map(canonicalReference)
        database
          .prepare(
            "INSERT INTO notes (id, source, title, text, created_at, updated_at) VALUES (?, 'internal', ?, ?, ?, ?)",
          )
          .run(id, title === undefined ? null : textOf(title, "a title", 500), textOf(text, "a note"), at, at)
        for (const to of targets) insertLink({ from: `note:${id}`, to, kind: "about", origin: "owner" })
        return noteOf(noteRow(id))
      }),
    note: async (id) => noteOf(noteRow(id)),
    notes: async (options = {}) => {
      const { limit, offset } = bounded(options.limit, options.offset)
      if (options.source !== undefined) oneOf(options.source, ["file", "internal"] as const, "a note's source")
      const about = options.about === undefined ? null : canonicalReference(options.about)
      const rows = database
        .prepare(
          "SELECT n.* FROM notes n WHERE n.deleted_at IS NULL AND (? IS NULL OR n.folder_id = ?) AND (? IS NULL OR n.source = ?) " +
            "AND (? IS NULL OR EXISTS (SELECT 1 FROM links l WHERE l.from_ref = 'note:' || n.id AND l.kind = 'about' AND l.to_ref = ?)) " +
            "AND (? IS NULL OR instr(lower(n.text), lower(?)) > 0) ORDER BY n.created_at DESC, n.id DESC LIMIT ? OFFSET ?",
        )
        .all(
          options.folderId ?? null,
          options.folderId ?? null,
          options.source ?? null,
          options.source ?? null,
          about,
          about,
          options.search ?? null,
          options.search ?? null,
          limit + 1,
          offset,
        )
      return { items: rows.slice(0, limit).map(noteOf), hasMore: rows.length > limit }
    },
    editNote: async (id, text, revision) =>
      atomic(() => {
        const found = noteRow(id)
        if (found.source !== "internal")
          throw new CliError("validation_error", "a file note is edited in its file; the next import reads it")
        const changed = database
          .prepare(
            "UPDATE notes SET text = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND deleted_at IS NULL",
          )
          .run(textOf(text, "a note"), now(), id, revision).changes
        if (!changed)
          throw new CliError("validation_error", "the note changed; read its current revision before editing")
        database
          .prepare("INSERT INTO note_revisions (note_pk, text, captured_at) VALUES (?, ?, ?)")
          .run(Number(found.pk), String(found.text), now())
        return noteOf(noteRow(id))
      }),
    removeNote: async (id) =>
      atomic(() => {
        if (noteRow(id).source !== "internal")
          throw new CliError("validation_error", "a file note goes when its file does; the next import notices")
        database.prepare("DELETE FROM notes WHERE id = ?").run(id)
        forgetCopied(database, { note: id })
        return { id, removed: true as const }
      }),
    addLink: async (input) => atomic(() => insertLink(input)),
    links: async (options = {}) => {
      const from = options.from === undefined ? null : canonicalReference(options.from)
      const to = options.to === undefined ? null : canonicalReference(options.to)
      return database
        .prepare(
          "SELECT * FROM links WHERE (? IS NULL OR from_ref = ?) AND (? IS NULL OR to_ref = ?) AND (? = 0 OR to_ref IS NULL) ORDER BY created_at, id LIMIT 5000",
        )
        .all(from, from, to, to, options.unresolved ? 1 : 0)
        .map(linkOf)
    },
    removeLink: async (id) =>
      atomic(() => {
        if (!database.prepare("DELETE FROM links WHERE id = ?").run(id).changes)
          throw new CliError("not_found", `no link ${id} in the local store`)
        forgetCopied(database, { link: id })
        return { id, removed: true as const }
      }),
    replaceFileLinks: async (noteId, links) =>
      atomic(() => {
        noteRow(noteId)
        const from = `note:${noteId}`
        database.prepare("DELETE FROM links WHERE from_ref = ? AND origin = 'file'").run(from)
        return links.map((link) => insertLink({ ...link, from, origin: "file" }))
      }),
    replaceFileTags: async (noteId, tags) =>
      atomic(() => {
        const pk = Number(noteRow(noteId).pk)
        const stated = [...new Set(tags.map(normalizeTag))]
        database
          .prepare(
            "DELETE FROM tags WHERE taggable_type = 'note' AND taggable_pk = ? AND manual = 0 AND tag NOT IN (SELECT value FROM json_each(?))",
          )
          .run(pk, JSON.stringify(stated))
        const insert = database.prepare(
          "INSERT INTO tags (taggable_type, taggable_pk, tag, created_at, manual) VALUES ('note', ?, ?, ?, 0) ON CONFLICT DO NOTHING",
        )
        const at = now()
        for (const tag of stated) insert.run(pk, tag, at)
        return tagsOfNote(pk)
      }),
    noteTags: async (noteId) => tagsOfNote(Number(noteRow(noteId).pk)),
    resolveLinks: async () =>
      atomic(() =>
        database
          .prepare("SELECT DISTINCT target_folded FROM links WHERE to_ref IS NULL AND target_folded IS NOT NULL")
          .all()
          .reduce((sum, row) => sum + resolveKey(database, String(row.target_folded)), 0),
      ),
    addEntity: async (kind, name) => {
      const at = now()
      const id = ulid(at)
      database
        .prepare("INSERT INTO entities (id, kind, name, created_at) VALUES (?, ?, ?, ?)")
        .run(id, oneOf(kind, ENTITY_KINDS, "an entity's kind"), textOf(name, "an entity's name", 200), at)
      return entityOf(database.prepare("SELECT * FROM entities WHERE id = ?").get(id) as Row)
    },
    entities: async () => database.prepare("SELECT * FROM entities ORDER BY name, id LIMIT 500").all().map(entityOf),
  }
}
