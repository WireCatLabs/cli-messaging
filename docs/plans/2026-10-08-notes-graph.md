# Notes as their own records, linked as a graph

**Status:** proposed 2026-10-08, waiting for the owner's review. Nothing here is built.
Spans this package (the store) and [cli-memo](https://github.com/leemour/cli-memo) (import, export, commands).

## 1. Goal

Notes stop being messages. A note — a file from a folder of Markdown, or a note written in memo about a
message, person or project — becomes its own record with a stable id, and every connection between
notes, messages, people, organisations and tasks is one row in one links table. The file format of a
folder (Obsidian today) sits behind one interface, so a plain Markdown folder or another editor's format
is a second implementation of it, not a change to the store.

Owner rulings (2026-10-08):

1. A folder of notes gets a real id. Its path is only where it lives on this computer, unique there,
   and may differ on another computer.
2. Notes get their own table. Internal notes and file notes share it (`source = internal | file`).
3. People, organisations, projects and notes belong to the owner, not to one messenger account.
4. Internal notes live in the store. A command and a flag write them out to a folder as Markdown, and
   the format of what is written is the folder's format, not Obsidian's by name.

## 2. Where things are now (`origin/main`, cli-messaging 0.193.0, cli-memo 0.2.0 unreleased)

- **File notes are messages.** cli-memo `src/notes/import.ts:30` makes each folder an account of
  provider `notes` whose id is the folder's absolute path, each subfolder a chat, each file a message.
  A note's locator is therefore `msg:notes/<percent-encoded absolute path>/<chat>/<file>` — it breaks
  when the folder moves or the store is used on another computer.
- **Links are not stored.** `[[wiki links]]` and `aliases` are parsed at search time
  (cli-memo `src/notes/links.ts:36`, called from `src/notes/search.ts:200`). Nothing can answer
  "what links to this person". `#tags` and `tags:` in front matter are not read.
- **Internal notes are `annotations`** (`src/store/sqlite/schema.ts:691`, migrations 22–23), each
  with a required `account_pk`; tg and max use them for `contacts notes …`
  (`src/cli/messenger/private-people-command.ts:26`), cli-memo for `memo annotations …`.
- **Organisations and relations** are `knowledge_entities` and `knowledge_relations`
  (`schema.ts:723`, `:733`), also with a required `account_pk` — an organisation has to name a
  Telegram or MAX account.
- **"The note about a person"** is a JSON file, `~/.config/cli-memo/people-notes.json`
  (cli-memo `src/people/notes-map.ts:13`), invisible to tg, max and agents.
- **Search is built on messages.** The word index (`message_words`), the stem index
  (`message_stems`), conversations and their chunks (`conversation_messages`,
  `conversation_chunks` `schema.ts:423`) and the vectors (`chunk_vectors` `:452`) all key on
  `messages.pk`. `memo context` finds notes naming a person with `store.find({ provider: "notes" })`
  (cli-memo `src/context/context.ts:70`).

## 3. Decisions

### 3.1 References: one typed form per kind of thing

Every end of a link, every tag target and every CLI argument naming a thing uses a typed reference:

| Kind | Form | Why this shape |
|---|---|---|
| message | `msg:<provider>/<account>/<chat>/<message>` (unchanged, `src/domain/locator.ts`) | a message id is unique only inside its chat or account |
| note | `note:<id>` | the id is ours and global |
| person | `person:<uid>` | already in use by `relationships add` |
| entity | `entity:<uid>` | already in use |
| task | `task:<id>` | already in use |
| chat | `chat:<provider>/<account>/<chat>` | same reason as messages |

The prefix is what makes a wrong kind fail loudly instead of matching the wrong row. Notes also accept
`note:<folder-id>/<path inside the folder>` on input, resolved to `note:<id>`.

### 3.2 Folders: an id in the store, a path per computer

- `note_folders(id, name, format, created_at)` — `format` names the dialect (§3.4).
- The path is in each computer's config only: `notes.folders: [{ "id": "fld_…", "path": "…" }]`.
  A path may appear once. The store holds no absolute path.
- `memo folders add <path> [--format obsidian|markdown]` creates the folder and prints its id.
  On a second computer using the same store, `memo folders attach <id> <path>` binds it. Importing a
  path that has no id is refused with both commands named — never a silent new folder, which would
  break every link to the old one.
- The store is not synced between computers today, as far as I know; this makes it safe to start.

### 3.3 Tables

- **`notes`** — `id` (ULID), `source` (`file | internal`), `folder_id` and `path` (file notes; unique
  together), `title`, `text`, `front_matter` (JSON, as parsed), `content_hash`, `created_at`,
  `updated_at`, `deleted_at`, `export_path` (internal notes written out, §3.5). No `account_pk`.
- **`note_revisions`** — earlier text, as `message_revisions` does for messages.
- **`links`** — `from_ref`, `to_ref`, `kind` (`links-to | about | member-of | related-to |
  assigned-to | mentions`), `anchor` (heading or block, nullable), `origin`
  (`file | owner | name-match`), `confirmed`, `created_at`. One table replaces both
  `annotations`' target columns and `knowledge_relations`. A `name-match` link is a guess and is never
  shown as a fact.
- **Tags** — `tags` gains the `note` target type. `#tag` and `tags:` from a file become tags with
  origin `file`, replaced on each import; tags the owner adds have origin `owner` and survive.
- **Entities** — `knowledge_entities` loses `account_pk`.
- The note about a person is a link `note:<id> --about--> person:<uid>`; `people-notes.json` is
  imported once and retired.

### 3.4 The format interface (dialects)

```ts
interface NoteDialect {
  name: string
  parse(text: string, path: string): ParsedNote  // title, aliases, tags, links, front matter
  render(note: NoteForExport): string             // body with links and front matter in this format
}
```

Two at first: **`obsidian`** (`[[Note|label]]`, `#heading` and `^block` anchors, `aliases`,
`#tag`, `tags:`) and **`markdown`** (`[label](relative/path.md)`, `tags:` in front matter). The store
holds only what `parse` returns — no `[[` survives into a table, the way no third-party MAX type crosses
max-cli's adapter. Resolving a parsed link to a note id (by path, file name or alias) is shared code,
not a dialect's job. A link in a file to `msg:…`, `person:…` or `entity:…` becomes a link to that
record, so a note in the editor can point at a chat.

### 3.5 Writing internal notes out

- `memo notes export --to <dir> [--format <dialect>]` writes every internal note; `memo notes add …
  --export [<dir>]` writes one as it is created. The default directory and format are in config.
- Each written file carries `memo-id: <note id>` in its front matter.
- **No loop:** import skips any file with a `memo-id`, so a file memo wrote never comes back as a
  file note, even when the export directory is inside an imported folder.
- **Never overwrite the owner's edits:** memo rewrites only a file it wrote whose hash is still the one
  it wrote. A file edited by hand since is reported and left alone. Nothing is deleted.

### 3.6 Search

Notes leave the message tables, so they need their own indexes. Two ways:

- **A · Parallel indexes for notes** — `note_words` (FTS5, as `message_words`) and note chunks feeding
  the existing vector table. Search code gains a second source and merges.
- **B · One "document" layer** that both messages and notes feed, with the index keyed by document.

I'd do **A**: B rewrites the search tg and max depend on daily, for a gain only memo sees. A costs one
word index, one chunk path and a merge step, and B stays possible later. `tg messages search
"in:notes …"` stops working; notes are searched with `memo notes search` and `memo search`.

### 3.7 Renames

With a stable id, a file gone from one path whose hash appears at a new path in the same import is a
rename: same id, links and tags kept. Today a move is a new identity. Small and worth doing here.

### 3.8 Compatibility

- Migrations go forward only. The new migration **copies** — annotations into `notes`
  (`source = internal`) plus an `about` link; `knowledge_relations` into `links`; tags and
  knowledge targets pointing at `msg:notes/<path>/…` rewritten to `note:<id>`; notes-provider messages
  into `notes`. Old tables and the `notes` provider's rows are left in place and recorded for removal
  in a later migration (a deletion, so `CLEANUP.md`).
- tg and max keep `contacts notes …` working over the new table; the services keep their signatures
  for one release. Removing `account_pk` from the API is the week's one breaking change, named in the
  changelog.
- Migration number: the next free one at build time (24 is held by another lane; announce it in
  [the lanes plan](2026-09-29-parity-lanes.md#4-releases-while-lanes-run) first).

## 4. Work items, in order

1. Announce the migration number (own PR).
2. Store: `note_folders`, `notes`, `note_revisions`, `links`, tag target `note`, `account_pk` dropped
   from entities, the copying migration; store API and services; `contacts notes` over `notes`.
3. Store: `note_words` and note chunks into the vector table (§3.6 A).
4. Release cli-messaging.
5. cli-memo: `folders add|attach|list`, config with ids, dialect interface with `obsidian` and
   `markdown`, import writing `notes`, `links` and file tags, rename detection.
6. cli-memo: internal notes on `notes` (`memo notes add|edit|show|remove` replacing
   `memo annotations`), `export` and `--export`, the import skip rule.
7. cli-memo: `context`, `search` and `notes about` read links (backlinks: everything pointing at a
   person or entity), `people-notes.json` imported once.
8. Docs (cli-memo README, cli-docs pages), release cli-memo; bump tg and max.

## 5. Tests

- Migration on a copy of a store with annotations, relations, notes-provider messages and tags on them:
  every row reachable by its new reference, none lost.
- Folder id: the same folder at two paths (two configs, one store) gives the same note ids; an
  unbound path is refused.
- Dialects: the same note parsed by `obsidian` and `markdown` gives the same rows; render then parse
  round-trips.
- Export: a written file is skipped on import; a hand-edited one is not overwritten.
- Rename keeps id, links and tags.
- tg/max `contacts notes` unchanged from the outside.

## 6. Open questions

- Should `mentions` (a person's full name found in a note) be stored as `name-match` links at import, or
  stay computed at search time? Stored is faster and listable; computed never goes stale. I'd store
  them, refreshed on each import of that note.
- `memo annotations` was never released on npm (cli-memo 0.1.2). Can it be replaced by `memo notes`
  outright, without a deprecation period? I'd say yes.
