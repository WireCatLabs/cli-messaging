import { CliError } from "@leemour/cli-core"
import type { CacheDatabase } from "./driver.js"

export interface Migration {
  version: number
  /** The oldest schema version whose statements still work on a file at this version. */
  minCompatible: number
  statements: string[]
}

/**
 * ⚠ **Append only. A migration that has reached anyone's file is never edited.** Forward-only and
 * additive: no `DROP` and no rebuild of a base table, a new column is nullable or has a default,
 * and every `INSERT` in the store names its columns — that is what lets an older `tg` keep writing
 * to a file a newer `max` has migrated. Only a breaking change raises `minCompatible`, and that is
 * a major version of this package. The search indexes are derived and may be dropped and rebuilt.
 *
 * Times are epoch milliseconds: an integer sorts and ranges without a format to agree on. Ids are
 * text: they are 64-bit, and they are not arithmetic.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    minCompatible: 1,
    statements: [
      `CREATE TABLE accounts (
         pk         INTEGER PRIMARY KEY,
         provider   TEXT NOT NULL,
         native_id  TEXT NOT NULL,
         name       TEXT,
         created_at INTEGER NOT NULL,
         UNIQUE (provider, native_id)
       )`,

      `CREATE TABLE persons (
         pk         INTEGER PRIMARY KEY,
         uid        TEXT NOT NULL UNIQUE,
         name       TEXT,
         is_self    INTEGER NOT NULL DEFAULT 0,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`,

      // Per provider, not per account: one Telegram user seen from two accounts is one identity.
      `CREATE TABLE identities (
         pk                INTEGER PRIMARY KEY,
         provider          TEXT NOT NULL,
         native_id         TEXT NOT NULL,
         username          TEXT,
         name              TEXT,
         is_bot            INTEGER,
         phone_hmac        TEXT,
         provider_metadata TEXT,
         first_seen_at     INTEGER NOT NULL,
         updated_at        INTEGER NOT NULL,
         UNIQUE (provider, native_id)
       )`,

      `CREATE TABLE identity_links (
         identity_pk INTEGER PRIMARY KEY REFERENCES identities (pk),
         person_pk   INTEGER NOT NULL REFERENCES persons (pk),
         method      TEXT NOT NULL,
         confidence  REAL NOT NULL,
         linked_at   INTEGER NOT NULL,
         linked_by   TEXT NOT NULL
       )`,
      `CREATE INDEX identity_links_by_person ON identity_links (person_pk)`,

      // An unlink loses nothing, and a bad automatic link can be found and undone.
      `CREATE TABLE identity_link_events (
         pk             INTEGER PRIMARY KEY,
         identity_pk    INTEGER NOT NULL REFERENCES identities (pk),
         from_person_pk INTEGER REFERENCES persons (pk),
         to_person_pk   INTEGER NOT NULL REFERENCES persons (pk),
         method         TEXT NOT NULL,
         at             INTEGER NOT NULL,
         by             TEXT NOT NULL
       )`,

      `CREATE TABLE chats (
         pk                 INTEGER PRIMARY KEY,
         account_pk         INTEGER NOT NULL REFERENCES accounts (pk),
         native_id          TEXT NOT NULL,
         kind               TEXT NOT NULL,
         title              TEXT,
         unread_count       INTEGER,
         last_message_at    INTEGER,
         participants_count INTEGER,
         provider_metadata  TEXT,
         updated_at         INTEGER NOT NULL,
         UNIQUE (account_pk, native_id)
       )`,
      `CREATE INDEX chats_by_recency ON chats (account_pk, last_message_at DESC)`,

      // `sender_chat_native_id` rather than a key: the channel a post came from is often not a chat
      // this account is in, and a row for it would appear in the chat list.
      `CREATE TABLE messages (
         pk                    INTEGER PRIMARY KEY,
         chat_pk               INTEGER NOT NULL REFERENCES chats (pk),
         account_pk            INTEGER NOT NULL REFERENCES accounts (pk),
         native_id             TEXT NOT NULL,
         thread_native_id      TEXT,
         sender_identity_pk    INTEGER REFERENCES identities (pk),
         sender_chat_native_id TEXT,
         sender_name           TEXT,
         sent_at               INTEGER NOT NULL,
         edited_at             INTEGER,
         deleted_at            INTEGER,
         text                  TEXT NOT NULL,
         reply_to_native_id    TEXT,
         reply_to              TEXT,
         forward               TEXT,
         outgoing              INTEGER,
         reactions             TEXT,
         provider_metadata     TEXT,
         ingested_at           INTEGER NOT NULL,
         ingested_via          TEXT NOT NULL,
         UNIQUE (chat_pk, native_id)
       )`,
      `CREATE INDEX messages_by_time ON messages (chat_pk, sent_at DESC)`,
      // Telegram deletes in private chats and basic groups name message ids without a chat.
      `CREATE INDEX messages_by_account ON messages (account_pk, native_id)`,
      `CREATE INDEX messages_by_sender ON messages (sender_identity_pk)`,

      `CREATE TABLE message_revisions (
         message_pk  INTEGER NOT NULL REFERENCES messages (pk),
         text        TEXT NOT NULL,
         edited_at   INTEGER,
         captured_at INTEGER NOT NULL
       )`,
      `CREATE INDEX revisions_by_message ON message_revisions (message_pk)`,

      `CREATE TABLE attachments (
         pk           INTEGER PRIMARY KEY,
         message_pk   INTEGER NOT NULL REFERENCES messages (pk),
         position     INTEGER NOT NULL,
         kind         TEXT NOT NULL,
         mime         TEXT,
         name         TEXT,
         title        TEXT,
         url          TEXT,
         size         INTEGER,
         width        INTEGER,
         height       INTEGER,
         duration     REAL,
         provider_ref TEXT,
         local_path   TEXT,
         UNIQUE (message_pk, position)
       )`,

      // Trigram matches inside a word and folds case in any alphabet (measured in max-cli); PR 2.4
      // measures it against unicode61 on a real group and may rebuild these.
      `CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='pk', tokenize='trigram')`,
      `CREATE VIRTUAL TABLE chats_fts USING fts5(title, content='chats', content_rowid='pk', tokenize='trigram')`,
      `CREATE VIRTUAL TABLE identities_fts USING fts5(name, username, content='identities', content_rowid='pk', tokenize='trigram')`,

      // An external-content index does not follow its table by itself; every write path goes through these.
      `CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
         INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.pk, old.text);
       END`,
      `CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
         INSERT INTO messages_fts (rowid, text) VALUES (new.pk, new.text);
       END`,
      `CREATE TRIGGER messages_fts_au AFTER UPDATE OF text ON messages BEGIN
         INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.pk, old.text);
         INSERT INTO messages_fts (rowid, text) VALUES (new.pk, new.text);
       END`,
      `CREATE TRIGGER chats_fts_ad AFTER DELETE ON chats BEGIN
         INSERT INTO chats_fts (chats_fts, rowid, title) VALUES ('delete', old.pk, old.title);
       END`,
      `CREATE TRIGGER chats_fts_ai AFTER INSERT ON chats BEGIN
         INSERT INTO chats_fts (rowid, title) VALUES (new.pk, new.title);
       END`,
      `CREATE TRIGGER chats_fts_au AFTER UPDATE OF title ON chats BEGIN
         INSERT INTO chats_fts (chats_fts, rowid, title) VALUES ('delete', old.pk, old.title);
         INSERT INTO chats_fts (rowid, title) VALUES (new.pk, new.title);
       END`,
      `CREATE TRIGGER identities_fts_ad AFTER DELETE ON identities BEGIN
         INSERT INTO identities_fts (identities_fts, rowid, name, username) VALUES ('delete', old.pk, old.name, old.username);
       END`,
      `CREATE TRIGGER identities_fts_ai AFTER INSERT ON identities BEGIN
         INSERT INTO identities_fts (rowid, name, username) VALUES (new.pk, new.name, new.username);
       END`,
      `CREATE TRIGGER identities_fts_au AFTER UPDATE OF name, username ON identities BEGIN
         INSERT INTO identities_fts (identities_fts, rowid, name, username) VALUES ('delete', old.pk, old.name, old.username);
         INSERT INTO identities_fts (rowid, name, username) VALUES (new.pk, new.name, new.username);
       END`,
    ],
  },
  {
    version: 2,
    minCompatible: 1,
    statements: [
      // The stretches of a chat held completely, by the provider's ordering key — Telegram's message
      // id. A message missing from inside one was deleted; outside every one, it was never fetched.
      `CREATE TABLE sync_ranges (
         chat_pk  INTEGER NOT NULL REFERENCES chats (pk),
         from_key INTEGER NOT NULL,
         to_key   INTEGER NOT NULL,
         PRIMARY KEY (chat_pk, from_key)
       )`,
    ],
  },
]

const HISTORY = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version        INTEGER PRIMARY KEY,
  min_compatible INTEGER NOT NULL,
  applied_at     INTEGER NOT NULL
)`

const latest = (migrations: Migration[]): number => migrations.at(-1)?.version ?? 0

const fileState = (database: CacheDatabase): { version: number; minCompatible: number } => {
  const row = database
    .prepare("SELECT version, min_compatible FROM schema_migrations ORDER BY version DESC LIMIT 1")
    .get()
  return { version: Number(row?.version ?? 0), minCompatible: Number(row?.min_compatible ?? 0) }
}

/**
 * Brings the file up to this version, or opens a newer one it can still write to, or refuses.
 * Inside `BEGIN IMMEDIATE`, so two processes opening an old file at once migrate it once.
 */
export const migrate = (
  database: CacheDatabase,
  { migrations = MIGRATIONS, now = Date.now }: { migrations?: Migration[]; now?: () => number } = {},
): void => {
  const ours = latest(migrations)
  database.exec("BEGIN IMMEDIATE")
  try {
    database.exec(HISTORY)
    const file = fileState(database)
    if (file.version > ours && file.minCompatible > ours) {
      throw new CliError(
        "configuration_error",
        `the message store was written by a newer version (schema ${file.version}, needs at least ` +
          `${file.minCompatible}; this one speaks ${ours}) — upgrade this tool`,
      )
    }
    for (const migration of migrations) {
      if (migration.version <= file.version) continue
      for (const statement of migration.statements) database.exec(statement)
      database
        .prepare("INSERT INTO schema_migrations (version, min_compatible, applied_at) VALUES (?, ?, ?)")
        .run(migration.version, migration.minCompatible, now())
    }
    database.exec("COMMIT")
  } catch (error) {
    database.exec("ROLLBACK")
    throw error
  }
}
