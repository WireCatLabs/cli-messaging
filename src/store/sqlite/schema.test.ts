import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { afterEach, describe, expect, it } from "vitest"
import type { CacheDatabase } from "../driver.js"
import { migrate } from "../migrations.js"
import { openCache } from "../open.js"
import { openStore } from "../store.js"
import { BASELINE } from "./manifest.js"
import { type OpenedSqlite, openSqlite } from "./open.js"
import { accounts } from "./schema.js"

const DOC = join(import.meta.dirname, "../../../docs/storage/schema-v2.md")
const fresh = () => join(mkdtempSync(join(tmpdir(), "schema-")), "messages.db")
const opened: CacheDatabase[] = []
afterEach(() => {
  for (const database of opened.splice(0)) database.close()
})

const open = async (): Promise<CacheDatabase> => {
  const database = await openCache(fresh())
  opened.push(database)
  return database
}

/** Every table the page lists, with its columns in order; a full-text index has none. */
const documented = (): Record<string, string[]> => {
  const tables: Record<string, string[]> = {}
  let current: string[] | undefined
  for (const line of readFileSync(DOC, "utf8").split("\n")) {
    if (line.startsWith("## ")) current = undefined
    const heading = /^### `(\w+)`/.exec(line)
    if (heading?.[1]) tables[heading[1]] = current = []
    const virtual = /^CREATE VIRTUAL TABLE (\w+)/.exec(line)
    if (virtual?.[1]) tables[virtual[1]] = []
    const column = /^\| `(\w+)`/.exec(line)
    if (column?.[1] && current) current.push(column[1])
  }
  return tables
}

/** What SQLite built, the same way: FTS5's own shadow tables left out. */
const built = (database: CacheDatabase): Record<string, string[]> => {
  const rows = (sql: string) => database.prepare(sql).all()
  const virtual = rows(`SELECT name FROM sqlite_schema WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'`).map(
    (row) => String(row.name),
  )
  const shadows = new Set(
    virtual.flatMap((name) => ["data", "idx", "docsize", "config", "content"].map((s) => `${name}_${s}`)),
  )
  const tables = rows(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .map((row) => String(row.name))
    .filter((name) => !shadows.has(name))
  return Object.fromEntries(
    tables.map((name) => [
      name,
      virtual.includes(name)
        ? []
        : rows(`SELECT name FROM pragma_table_info('${name}') ORDER BY cid`).map((row) => String(row.name)),
    ]),
  )
}

describe("the v2 baseline", () => {
  it("**creates exactly the tables and columns schema-v2.md lists** when a store opens on an empty path", async () => {
    const path = fresh()
    await (await openStore({ path })).close()
    const database = await openCache(path)
    opened.push(database)

    expect(built(database)).toEqual(documented())
  })

  it("**runs every trigger and full-text index** on real rows, under the new column names", async () => {
    const database = await open()
    migrate(database)
    const run = (sql: string) => database.exec(sql)
    const all = (sql: string) => database.prepare(sql).all()
    const one = (sql: string) => database.prepare(sql).get()

    run(
      `INSERT INTO accounts (provider, external_id, name, created_at, updated_at) VALUES ('telegram', '1', 'Alice', 1, 1)`,
    )
    run(`INSERT INTO identities (provider, external_id, name, username, created_at, updated_at)
           VALUES ('telegram', '2', 'Bob Sample', 'bobsample', 1, 1)`)
    run(`INSERT INTO chats (account_id, external_id, kind, title, updated_at, created_at)
           VALUES (1, '3', 'group', 'Garden club', 1, 1)`)
    run(`INSERT INTO messages (chat_id, account_id, external_id, sender_identity_id, sent_at, text, created_at, source,
           normalized_text, updated_at) VALUES (1, 1, '4', 1, 1, 'Tomatoes ripen', 1, 'sync', 'tomatoes ripen', 1)`)
    run(`INSERT INTO attachments (attachable_type, attachable_id, position, kind, text, normalized_text, created_at,
           updated_at) VALUES ('message', 1, 0, 'document', 'Seed catalogue', 'seed catalogue', 1, 1)`)
    run(`INSERT INTO tags (name, created_at, updated_at) VALUES ('garden', 1, 1)`)
    run(`INSERT INTO taggings (tag_id, taggable_type, taggable_id, source, created_at, updated_at)
           VALUES (1, 'message', 1, 'owner', 1, 1), (1, 'chat', 1, 'owner', 1, 1)`)
    run(`INSERT INTO auto_tag_claims (chat_id, tag_id, algorithm, score, fields, created_at, updated_at)
           VALUES (1, 1, 'rule', 1, '[]', 1, 1)`)
    run(`INSERT INTO aliases (aliasable_type, aliasable_id, account_id, name, name_folded, source, created_at, updated_at)
           VALUES ('identity', 1, NULL, 'Bobby', 'bobby', 'owner', 1, 1), ('chat', 1, NULL, 'Club', 'club', 'owner', 1, 1),
                  ('person', 9, 1, 'B', 'b', 'owner', 1, 1)`)

    for (const index of ["identities_fts", "chats_fts", "messages_fts"])
      run(`INSERT INTO ${index} (${index}) VALUES ('integrity-check')`)
    expect(all(`SELECT rowid FROM identities_fts WHERE identities_fts MATCH 'Sample'`)).toEqual([{ rowid: 1 }])
    expect(all(`SELECT rowid FROM chats_fts WHERE chats_fts MATCH 'Garden'`)).toEqual([{ rowid: 1 }])
    expect(all(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'ripen'`)).toEqual([{ rowid: 1 }])
    expect(all(`SELECT rowid FROM message_words WHERE message_words MATCH 'tomatoes AND scope:c1'`)).toEqual([
      { rowid: 1 },
    ])
    expect(all(`SELECT term FROM message_words_vocab WHERE col = 'normalized_text' ORDER BY term`)).toEqual([
      { term: "ripen" },
      { term: "tomatoes" },
    ])
    expect(all(`SELECT rowid FROM attachment_words WHERE attachment_words MATCH 'catalogue'`)).toEqual([{ rowid: 1 }])
    expect(all("SELECT id FROM message_stems_pending")).toEqual([{ id: 1 }])
    expect(one("SELECT message_count FROM chats")).toEqual({ message_count: 1 })

    run("UPDATE messages SET deleted_at = 2")
    expect(one("SELECT message_count FROM chats")).toEqual({ message_count: 0 })
    expect(one("SELECT text, normalized_text FROM attachments")).toEqual({ text: null, normalized_text: null })
    expect(all(`SELECT rowid FROM attachment_words WHERE attachment_words MATCH 'catalogue'`)).toEqual([])
    expect(all("SELECT taggable_type FROM taggings")).toEqual([{ taggable_type: "chat" }])
    run("UPDATE messages SET deleted_at = NULL")
    expect(one("SELECT message_count FROM chats")).toEqual({ message_count: 1 })

    run("DELETE FROM messages")
    expect(one("SELECT count(*) AS n FROM attachments")).toEqual({ n: 0 })
    expect(one("SELECT count(*) AS n FROM message_stems_pending")).toEqual({ n: 0 })
    expect(all(`SELECT rowid FROM message_words WHERE message_words MATCH 'tomatoes'`)).toEqual([])
    run("DELETE FROM chats")
    expect(all("SELECT name FROM aliases ORDER BY name")).toEqual([{ name: "B" }, { name: "Bobby" }])
    expect(one("SELECT count(*) AS n FROM taggings")).toEqual({ n: 0 })
    expect(one("SELECT count(*) AS n FROM auto_tag_claims")).toEqual({ n: 0 })
    run("DELETE FROM identities")
    expect(all("SELECT name FROM aliases")).toEqual([{ name: "B" }])
    run("INSERT INTO identities_fts (identities_fts) VALUES ('integrity-check')")

    run(`INSERT INTO projects (key, name, created_at, updated_at) VALUES ('MEET', 'Meetings', 1, 1)`)
    run(`INSERT INTO tasks (project_id, number, key, title, type, status, author_type, author_id, source, created_at,
           updated_at) VALUES (1, 1, 'MEET-1', 'Send the notes', 'promise', 'open', 'person', 1, 'owner', 1, 1)`)
    run(`INSERT INTO reminders (task_id, account_id, due_at, timezone, state, created_at, updated_at)
           VALUES (1, 1, 5, 'UTC', 'pending', 1, 1), (1, 1, 6, 'UTC', 'pending', 1, 1)`)
    run("UPDATE tasks SET status = 'in_progress'")
    expect(all("SELECT DISTINCT state FROM reminders")).toEqual([{ state: "pending" }])
    run("UPDATE tasks SET status = 'done'")
    expect(all("SELECT DISTINCT state, revision FROM reminders")).toEqual([{ state: "cancelled", revision: 2 }])
    run("DELETE FROM reminders WHERE id = 2")
    run("DELETE FROM accounts")
    expect(one("SELECT count(*) AS n FROM aliases")).toEqual({ n: 0 })
    expect(one("SELECT count(*) AS n FROM reminders")).toEqual({ n: 0 })
  })

  it("queues documents, notes and emails for the indexer and clears what hangs off them on delete", async () => {
    const database = await open()
    migrate(database)
    const run = (sql: string) => database.exec(sql)
    const all = (sql: string) => database.prepare(sql).all()

    run(`INSERT INTO accounts (provider, external_id, created_at, updated_at) VALUES ('folder', 'notes', 1, 1)`)
    run(`INSERT INTO documents (account_id, external_id, kind, title, body, revision, created_at, updated_at)
           VALUES (1, 'a.md', 'file', 'Seeds', 'Sow in March', 1, 1, 1)`)
    run(`INSERT INTO document_revisions (document_id, body, revision, created_at) VALUES (1, 'Sow', 0, 1)`)
    run(`INSERT INTO notes (notable_type, notable_id, body, revision, created_at, updated_at)
           VALUES ('document', 1, 'Check the frost dates', 1, 1, 1)`)
    run(`INSERT INTO chunks (chunkable_type, chunkable_id, position, start_offset, end_offset, content_hash, created_at,
           updated_at) VALUES ('document', 1, 0, 0, 4, 'shared', 1, 1), ('document', 1, 1, 4, 8, 'own', 1, 1),
                              ('note', 1, 0, 0, 5, 'shared', 1, 1)`)
    run(`INSERT INTO embeddings (model, content_hash, dims, vector, created_at, updated_at)
           VALUES ('m', 'shared', 1, x'00000000', 1, 1), ('m', 'own', 1, x'00000000', 1, 1)`)
    run(`INSERT INTO email_threads (account_id, external_id, created_at, updated_at) VALUES (1, 't', 1, 1)`)
    run(`INSERT INTO emails (account_id, email_thread_id, external_id, subject, "references", created_at, updated_at)
           VALUES (1, 1, '<a@example.com>', 'Seeds', '[]', 1, 1)`)
    run(`INSERT INTO email_words (rowid, normalized_text, scope) VALUES (1, 'seeds', '')`)

    expect(all("SELECT indexable_type, id FROM document_index_pending")).toEqual([
      { indexable_type: "document", id: 1 },
    ])
    expect(all("SELECT indexable_type, id FROM note_index_pending")).toEqual([{ indexable_type: "note", id: 1 }])
    expect(all("SELECT indexable_type, id FROM email_index_pending")).toEqual([{ indexable_type: "email", id: 1 }])

    run("DELETE FROM documents")
    expect(all("SELECT content_hash FROM embeddings")).toEqual([{ content_hash: "shared" }])
    expect(all("SELECT chunkable_type FROM chunks")).toEqual([{ chunkable_type: "note" }])
    expect(all("SELECT count(*) AS n FROM document_revisions")).toEqual([{ n: 0 }])
    expect(all("SELECT count(*) AS n FROM document_index_pending")).toEqual([{ n: 0 }])
    run("DELETE FROM notes")
    expect(all("SELECT count(*) AS n FROM embeddings")).toEqual([{ n: 0 }])
    run("DELETE FROM emails")
    expect(all("SELECT count(*) AS n FROM email_index_pending")).toEqual([{ n: 0 }])
    expect(all(`SELECT rowid FROM email_words WHERE email_words MATCH 'seeds'`)).toEqual([])
  })

  it("queues every meeting text by type, so rows of different tables with one id both wait", async () => {
    const database = await open()
    migrate(database)
    const run = (sql: string) => database.exec(sql)

    run(`INSERT INTO accounts (provider, external_id, created_at, updated_at) VALUES ('zoom', 'z', 1, 1)`)
    run(
      `INSERT INTO identities (provider, external_id, name, created_at, updated_at) VALUES ('zoom', 'p', 'Alice Example', 1, 1)`,
    )
    run(`INSERT INTO meetings (account_id, external_id, created_at, updated_at) VALUES (1, 'm', 1, 1)`)
    run(`INSERT INTO meeting_participants (meeting_id, identity_id, created_at, updated_at) VALUES (1, 1, 1, 1)`)
    run(`INSERT INTO meeting_transcripts (meeting_id, source, created_at, updated_at) VALUES (1, 'api', 1, 1)`)
    run(`INSERT INTO meeting_transcript_rows (meeting_transcript_id, position, start_ms, end_ms, speaker_participant_id,
           text, created_at) VALUES (1, 0, 0, 900, 1, 'Hello', 1)`)
    run(
      `INSERT INTO meeting_chat_messages (meeting_id, sent_at, text, created_at, updated_at) VALUES (1, 1, 'Hi', 1, 1)`,
    )
    run(
      `INSERT INTO meeting_summaries (meeting_id, source, overview, created_at, updated_at) VALUES (1, 'llm', 'A call', 1, 1)`,
    )
    run("DELETE FROM meeting_index_pending")
    run("UPDATE meeting_transcript_rows SET text = 'Hello there'")
    run("DELETE FROM meeting_chat_messages")

    expect(
      database.prepare("SELECT indexable_type, id FROM meeting_index_pending ORDER BY indexable_type").all(),
    ).toEqual([
      { indexable_type: "meeting_chat_message", id: 1 },
      { indexable_type: "meeting_transcript_row", id: 1 },
    ])
  })

  it(`**is version ${BASELINE}**: a file of the old line is refused with the way to convert it`, async () => {
    const database = await open()
    database.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, min_compatible INTEGER NOT NULL, applied_at INTEGER NOT NULL)",
    )
    database.exec("INSERT INTO schema_migrations VALUES (28, 28, 1)")

    expect(() => migrate(database)).toThrow(/schema 28, from before store v2 — convert it once with `store upgrade-v2`/)
  })

  it("is refused by a build of the old line, which speaks up to version 28", async () => {
    const database = await open()
    migrate(database)

    expect(() => migrate(database, { migrations: [{ version: 28, minCompatible: 28, statements: [] }] })).toThrow(
      /written by a newer version \(schema 100, needs at least 100; this one speaks 28\)/,
    )
  })

  it("reads through Drizzle what the hand-written SQL wrote, over one connection", async () => {
    const store: OpenedSqlite = await openSqlite(fresh())
    migrate(store.database)
    store.database
      .prepare("INSERT INTO accounts (provider, external_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("telegram", "100", "Alice", 1, 2)

    expect(await store.orm.select().from(accounts).where(eq(accounts.externalId, "100"))).toEqual([
      {
        id: 1,
        provider: "telegram",
        externalId: "100",
        name: "Alice",
        createdAt: 1,
        settings: null,
        status: null,
        updatedAt: 2,
      },
    ])
    store.database.close()
  })
})
