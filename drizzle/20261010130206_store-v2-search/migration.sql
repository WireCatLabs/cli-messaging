-- Trigram indexes over names and text, kept by triggers; external content, so their rowid is the row's id.
CREATE VIRTUAL TABLE identities_fts USING fts5(name, username, content='identities', content_rowid='id', tokenize='trigram');--> statement-breakpoint
CREATE TRIGGER identities_fts_ai AFTER INSERT ON identities BEGIN
  INSERT INTO identities_fts (rowid, name, username) VALUES (new.id, new.name, new.username);
END;--> statement-breakpoint
CREATE TRIGGER identities_fts_au AFTER UPDATE OF name, username ON identities BEGIN
  INSERT INTO identities_fts (identities_fts, rowid, name, username) VALUES ('delete', old.id, old.name, old.username);
  INSERT INTO identities_fts (rowid, name, username) VALUES (new.id, new.name, new.username);
END;--> statement-breakpoint
CREATE TRIGGER identities_fts_ad AFTER DELETE ON identities BEGIN
  INSERT INTO identities_fts (identities_fts, rowid, name, username) VALUES ('delete', old.id, old.name, old.username);
END;--> statement-breakpoint
CREATE VIRTUAL TABLE chats_fts USING fts5(title, content='chats', content_rowid='id', tokenize='trigram');--> statement-breakpoint
CREATE TRIGGER chats_fts_ai AFTER INSERT ON chats BEGIN
  INSERT INTO chats_fts (rowid, title) VALUES (new.id, new.title);
END;--> statement-breakpoint
CREATE TRIGGER chats_fts_au AFTER UPDATE OF title ON chats BEGIN
  INSERT INTO chats_fts (chats_fts, rowid, title) VALUES ('delete', old.id, old.title);
  INSERT INTO chats_fts (rowid, title) VALUES (new.id, new.title);
END;--> statement-breakpoint
CREATE TRIGGER chats_fts_ad AFTER DELETE ON chats BEGIN
  INSERT INTO chats_fts (chats_fts, rowid, title) VALUES ('delete', old.id, old.title);
END;--> statement-breakpoint
-- Trigram for message text (owner, 2026-09-29): a search finds any three letters inside a word.
CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='id', tokenize='trigram');--> statement-breakpoint
CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
END;--> statement-breakpoint
CREATE TRIGGER messages_fts_au AFTER UPDATE OF text ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
END;--> statement-breakpoint
CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;--> statement-breakpoint
CREATE TRIGGER chats_count_ai AFTER INSERT ON messages WHEN new.deleted_at IS NULL BEGIN
  UPDATE chats SET message_count = message_count + 1 WHERE id = new.chat_id;
END;--> statement-breakpoint
CREATE TRIGGER chats_count_ad AFTER DELETE ON messages WHEN old.deleted_at IS NULL BEGIN
  UPDATE chats SET message_count = message_count - 1 WHERE id = old.chat_id;
END;--> statement-breakpoint
CREATE TRIGGER chats_count_tombstone AFTER UPDATE OF deleted_at ON messages
  WHEN old.deleted_at IS NULL AND new.deleted_at IS NOT NULL BEGIN
  UPDATE chats SET message_count = message_count - 1 WHERE id = new.chat_id;
END;--> statement-breakpoint
CREATE TRIGGER chats_count_untombstone AFTER UPDATE OF deleted_at ON messages
  WHEN old.deleted_at IS NOT NULL AND new.deleted_at IS NULL BEGIN
  UPDATE chats SET message_count = message_count + 1 WHERE id = new.chat_id;
END;--> statement-breakpoint
-- Words of the normalized text, ranked by bm25. Contentless with delete support: an index filled in
-- batches after its triggers exist stays consistent only this way. `scope` holds `c<chat_id>` and
-- `s<sender_identity_id>` so a small chat or a sender is filtered inside the index.
CREATE VIRTUAL TABLE message_words USING fts5(
  normalized_text, scope,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2', prefix = '3');--> statement-breakpoint
-- 'col', not 'row': the scope tokens must never come back as a word or a correction.
CREATE VIRTUAL TABLE message_words_vocab USING fts5vocab(message_words, 'col');--> statement-breakpoint
CREATE TRIGGER message_words_ai AFTER INSERT ON messages WHEN new.normalized_text <> '' BEGIN
  INSERT INTO message_words (rowid, normalized_text, scope)
    VALUES (new.id, new.normalized_text, 'c' || new.chat_id || coalesce(' s' || new.sender_identity_id, ''));
END;--> statement-breakpoint
-- Every re-save of a message sets these columns; only a real change may touch the index.
CREATE TRIGGER message_words_au AFTER UPDATE OF normalized_text, sender_identity_id, chat_id ON messages
  WHEN old.normalized_text IS NOT new.normalized_text
    OR old.sender_identity_id IS NOT new.sender_identity_id
    OR old.chat_id IS NOT new.chat_id BEGIN
  DELETE FROM message_words WHERE rowid = old.id;
  INSERT INTO message_words (rowid, normalized_text, scope)
    SELECT new.id, new.normalized_text, 'c' || new.chat_id || coalesce(' s' || new.sender_identity_id, '')
    WHERE new.normalized_text <> '';
END;--> statement-breakpoint
CREATE TRIGGER message_words_ad AFTER DELETE ON messages BEGIN
  DELETE FROM message_words WHERE rowid = old.id;
END;--> statement-breakpoint
-- Snowball stems, shaped like `message_words` so its `scope` filter and bm25 weights carry over. No prefix
-- index: wildcards never read stems. SQL cannot stem, so the triggers only queue the row and JS writes the
-- stems. Every `*_stems` index below follows this recipe.
CREATE VIRTUAL TABLE message_stems USING fts5(
  stems, scope,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2');--> statement-breakpoint
CREATE TRIGGER message_stems_ai AFTER INSERT ON messages WHEN new.text <> '' BEGIN
  INSERT OR IGNORE INTO message_stems_pending (id) VALUES (new.id);
END;--> statement-breakpoint
CREATE TRIGGER message_stems_au AFTER UPDATE OF text, sender_identity_id, chat_id ON messages
  WHEN old.text IS NOT new.text
    OR old.sender_identity_id IS NOT new.sender_identity_id
    OR old.chat_id IS NOT new.chat_id BEGIN
  INSERT OR IGNORE INTO message_stems_pending (id) VALUES (new.id);
END;--> statement-breakpoint
CREATE TRIGGER message_stems_ad AFTER DELETE ON messages BEGIN
  DELETE FROM message_stems WHERE rowid = old.id;
  DELETE FROM message_stems_pending WHERE id = old.id;
END;--> statement-breakpoint
-- Words of an attachment's text, rowid = attachment id. Apart from message_words so `text:` stays what was
-- written and a file's words never rank a message.
CREATE VIRTUAL TABLE attachment_words USING fts5(
  normalized_text,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2');--> statement-breakpoint
CREATE TRIGGER attachment_words_ai AFTER INSERT ON attachments WHEN new.normalized_text <> '' BEGIN
  INSERT INTO attachment_words (rowid, normalized_text) VALUES (new.id, new.normalized_text);
END;--> statement-breakpoint
CREATE TRIGGER attachment_words_au AFTER UPDATE OF normalized_text ON attachments
  WHEN old.normalized_text IS NOT new.normalized_text BEGIN
  DELETE FROM attachment_words WHERE rowid = old.id;
  INSERT INTO attachment_words (rowid, normalized_text)
    SELECT new.id, new.normalized_text WHERE new.normalized_text <> '';
END;--> statement-breakpoint
CREATE TRIGGER attachment_words_ad AFTER DELETE ON attachments BEGIN
  DELETE FROM attachment_words WHERE rowid = old.id;
END;--> statement-breakpoint
-- Polymorphic rows have no foreign key to cascade by: these keep what hangs off a message, a chat, an
-- identity or an account from outliving it, whichever build deletes it.
CREATE TRIGGER message_tombstone AFTER UPDATE OF deleted_at ON messages
  WHEN old.deleted_at IS NULL AND new.deleted_at IS NOT NULL BEGIN
  UPDATE attachments SET text = NULL, normalized_text = NULL
    WHERE attachable_type = 'message' AND attachable_id = new.id;
  DELETE FROM taggings WHERE taggable_type = 'message' AND taggable_id = new.id;
END;--> statement-breakpoint
CREATE TRIGGER message_ad AFTER DELETE ON messages BEGIN
  DELETE FROM attachments WHERE attachable_type = 'message' AND attachable_id = old.id;
  DELETE FROM taggings WHERE taggable_type = 'message' AND taggable_id = old.id;
END;--> statement-breakpoint
CREATE TRIGGER chat_bd BEFORE DELETE ON chats BEGIN
  DELETE FROM auto_tag_claims WHERE chat_id = old.id;
  DELETE FROM taggings WHERE taggable_type = 'chat' AND taggable_id = old.id;
  DELETE FROM aliases WHERE aliasable_type = 'chat' AND aliasable_id = old.id;
END;--> statement-breakpoint
CREATE TRIGGER identity_bd BEFORE DELETE ON identities BEGIN
  DELETE FROM aliases WHERE aliasable_type = 'identity' AND aliasable_id = old.id;
END;--> statement-breakpoint
CREATE TRIGGER account_bd BEFORE DELETE ON accounts BEGIN
  DELETE FROM aliases WHERE account_id = old.id;
  DELETE FROM reminders WHERE account_id = old.id;
  DELETE FROM bot_updates WHERE account_id = old.id;
END;--> statement-breakpoint
CREATE TRIGGER reminders_task_closed AFTER UPDATE OF status ON tasks
  WHEN new.status IN ('done', 'dismissed') AND old.status NOT IN ('done', 'dismissed') BEGIN
  UPDATE reminders SET state = 'cancelled', receipt = NULL, lease_until = NULL, revision = revision + 1
    WHERE task_id = new.id AND state IN ('pending', 'leased');
END;--> statement-breakpoint
-- Documents, notes, emails and meetings: written by JS from a queue, not by triggers, because the words are
-- normalized and the stems computed in JS; every writer only has to enqueue. The words indexes follow
-- `message_words` (prefix index, a 'col' vocabulary).
CREATE VIRTUAL TABLE document_words USING fts5(
  normalized_text, scope,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2', prefix = '3');--> statement-breakpoint
CREATE VIRTUAL TABLE document_words_vocab USING fts5vocab(document_words, 'col');--> statement-breakpoint
CREATE VIRTUAL TABLE document_stems USING fts5(
  stems, scope,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2');--> statement-breakpoint
CREATE TRIGGER document_index_ai AFTER INSERT ON documents BEGIN
  INSERT OR IGNORE INTO document_index_pending (indexable_type, id) VALUES ('document', new.id);
END;--> statement-breakpoint
CREATE TRIGGER document_index_au AFTER UPDATE OF title, body, deleted_at, account_id ON documents
  WHEN old.title IS NOT new.title OR old.body IS NOT new.body OR old.deleted_at IS NOT new.deleted_at
    OR old.account_id IS NOT new.account_id BEGIN
  INSERT OR IGNORE INTO document_index_pending (indexable_type, id) VALUES ('document', new.id);
END;--> statement-breakpoint
CREATE TRIGGER document_tombstone AFTER UPDATE OF deleted_at ON documents
  WHEN old.deleted_at IS NULL AND new.deleted_at IS NOT NULL BEGIN
  DELETE FROM taggings WHERE taggable_type = 'document' AND taggable_id = new.id;
END;--> statement-breakpoint
-- A vector is keyed by text alone, so it goes only when no other chunk or conversation chunk still uses it.
CREATE TRIGGER document_bd BEFORE DELETE ON documents BEGIN
  DELETE FROM embeddings WHERE content_hash IN (
    SELECT k.content_hash FROM chunks k WHERE k.chunkable_type = 'document' AND k.chunkable_id = old.id
      AND NOT EXISTS (SELECT 1 FROM chunks o WHERE o.content_hash = k.content_hash
        AND NOT (o.chunkable_type = 'document' AND o.chunkable_id = old.id))
      AND NOT EXISTS (SELECT 1 FROM conversation_chunks c WHERE c.content_hash = k.content_hash));
  DELETE FROM chunks WHERE chunkable_type = 'document' AND chunkable_id = old.id;
  DELETE FROM document_words WHERE rowid = old.id;
  DELETE FROM document_stems WHERE rowid = old.id;
  DELETE FROM document_index_pending WHERE indexable_type = 'document' AND id = old.id;
  DELETE FROM document_revisions WHERE document_id = old.id;
  DELETE FROM taggings WHERE taggable_type = 'document' AND taggable_id = old.id;
  DELETE FROM links WHERE from_type = 'document' AND from_id = old.id;
END;--> statement-breakpoint
CREATE VIRTUAL TABLE note_words USING fts5(
  normalized_text, scope,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2', prefix = '3');--> statement-breakpoint
CREATE VIRTUAL TABLE note_words_vocab USING fts5vocab(note_words, 'col');--> statement-breakpoint
CREATE VIRTUAL TABLE note_stems USING fts5(
  stems, scope,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2');--> statement-breakpoint
CREATE TRIGGER note_index_ai AFTER INSERT ON notes BEGIN
  INSERT OR IGNORE INTO note_index_pending (indexable_type, id) VALUES ('note', new.id);
END;--> statement-breakpoint
CREATE TRIGGER note_index_au AFTER UPDATE OF title, body, deleted_at, notable_type, notable_id ON notes
  WHEN old.title IS NOT new.title OR old.body IS NOT new.body OR old.deleted_at IS NOT new.deleted_at
    OR old.notable_type IS NOT new.notable_type OR old.notable_id IS NOT new.notable_id BEGIN
  INSERT OR IGNORE INTO note_index_pending (indexable_type, id) VALUES ('note', new.id);
END;--> statement-breakpoint
CREATE TRIGGER note_tombstone AFTER UPDATE OF deleted_at ON notes
  WHEN old.deleted_at IS NULL AND new.deleted_at IS NOT NULL BEGIN
  DELETE FROM taggings WHERE taggable_type = 'note' AND taggable_id = new.id;
END;--> statement-breakpoint
CREATE TRIGGER note_bd BEFORE DELETE ON notes BEGIN
  DELETE FROM embeddings WHERE content_hash IN (
    SELECT k.content_hash FROM chunks k WHERE k.chunkable_type = 'note' AND k.chunkable_id = old.id
      AND NOT EXISTS (SELECT 1 FROM chunks o WHERE o.content_hash = k.content_hash
        AND NOT (o.chunkable_type = 'note' AND o.chunkable_id = old.id))
      AND NOT EXISTS (SELECT 1 FROM conversation_chunks c WHERE c.content_hash = k.content_hash));
  DELETE FROM chunks WHERE chunkable_type = 'note' AND chunkable_id = old.id;
  DELETE FROM note_words WHERE rowid = old.id;
  DELETE FROM note_stems WHERE rowid = old.id;
  DELETE FROM note_index_pending WHERE indexable_type = 'note' AND id = old.id;
  DELETE FROM note_revisions WHERE note_id = old.id;
  DELETE FROM taggings WHERE taggable_type = 'note' AND taggable_id = old.id;
  DELETE FROM links WHERE from_type = 'note' AND from_id = old.id;
END;--> statement-breakpoint
CREATE VIRTUAL TABLE memory_words USING fts5(
  normalized_text, scope,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2', prefix = '3');--> statement-breakpoint
CREATE VIRTUAL TABLE memory_words_vocab USING fts5vocab(memory_words, 'col');--> statement-breakpoint
CREATE VIRTUAL TABLE memory_stems USING fts5(
  stems, scope,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2');--> statement-breakpoint
CREATE TRIGGER memory_index_ai AFTER INSERT ON memories BEGIN
  INSERT OR IGNORE INTO memory_index_pending (indexable_type, id) VALUES ('memory', new.id);
END;--> statement-breakpoint
CREATE TRIGGER memory_index_au AFTER UPDATE OF body, status, scope, subject_type, subject_id ON memories
  WHEN old.body IS NOT new.body OR old.status IS NOT new.status OR old.scope IS NOT new.scope
    OR old.subject_type IS NOT new.subject_type OR old.subject_id IS NOT new.subject_id BEGIN
  INSERT OR IGNORE INTO memory_index_pending (indexable_type, id) VALUES ('memory', new.id);
END;--> statement-breakpoint
-- A memory's evidence is links from it; they go with it, the sources they point at stay.
CREATE TRIGGER memory_bd BEFORE DELETE ON memories BEGIN
  DELETE FROM embeddings WHERE content_hash IN (
    SELECT k.content_hash FROM chunks k WHERE k.chunkable_type = 'memory' AND k.chunkable_id = old.id
      AND NOT EXISTS (SELECT 1 FROM chunks o WHERE o.content_hash = k.content_hash
        AND NOT (o.chunkable_type = 'memory' AND o.chunkable_id = old.id))
      AND NOT EXISTS (SELECT 1 FROM conversation_chunks c WHERE c.content_hash = k.content_hash));
  DELETE FROM chunks WHERE chunkable_type = 'memory' AND chunkable_id = old.id;
  DELETE FROM memory_words WHERE rowid = old.id;
  DELETE FROM memory_stems WHERE rowid = old.id;
  DELETE FROM memory_index_pending WHERE indexable_type = 'memory' AND id = old.id;
  DELETE FROM taggings WHERE taggable_type = 'memory' AND taggable_id = old.id;
  DELETE FROM links WHERE from_type = 'memory' AND from_id = old.id;
END;--> statement-breakpoint
CREATE VIRTUAL TABLE email_words USING fts5(
  normalized_text, scope,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2', prefix = '3');--> statement-breakpoint
CREATE VIRTUAL TABLE email_words_vocab USING fts5vocab(email_words, 'col');--> statement-breakpoint
CREATE VIRTUAL TABLE email_stems USING fts5(
  stems, scope,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2');--> statement-breakpoint
CREATE TRIGGER email_index_ai AFTER INSERT ON emails BEGIN
  INSERT OR IGNORE INTO email_index_pending (indexable_type, id) VALUES ('email', new.id);
END;--> statement-breakpoint
CREATE TRIGGER email_index_au AFTER UPDATE OF subject, body_text, deleted_at, email_thread_id ON emails
  WHEN old.subject IS NOT new.subject OR old.body_text IS NOT new.body_text
    OR old.deleted_at IS NOT new.deleted_at OR old.email_thread_id IS NOT new.email_thread_id BEGIN
  INSERT OR IGNORE INTO email_index_pending (indexable_type, id) VALUES ('email', new.id);
END;--> statement-breakpoint
CREATE TRIGGER email_bd BEFORE DELETE ON emails BEGIN
  DELETE FROM email_words WHERE rowid = old.id;
  DELETE FROM email_stems WHERE rowid = old.id;
  DELETE FROM email_index_pending WHERE indexable_type = 'email' AND id = old.id;
  DELETE FROM attachments WHERE attachable_type = 'email' AND attachable_id = old.id;
  DELETE FROM taggings WHERE taggable_type = 'email' AND taggable_id = old.id;
END;--> statement-breakpoint
-- Three tables feed the meeting index and their ids overlap, so the rowid scheme is the indexer's: a change
-- or a delete only queues the row, and the drain removes what it finds gone.
CREATE VIRTUAL TABLE meeting_words USING fts5(
  normalized_text, scope,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2', prefix = '3');--> statement-breakpoint
CREATE VIRTUAL TABLE meeting_words_vocab USING fts5vocab(meeting_words, 'col');--> statement-breakpoint
CREATE VIRTUAL TABLE meeting_stems USING fts5(
  stems, scope,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2');--> statement-breakpoint
CREATE TRIGGER meeting_transcript_row_index_ai AFTER INSERT ON meeting_transcript_rows BEGIN
  INSERT OR IGNORE INTO meeting_index_pending (indexable_type, id) VALUES ('meeting_transcript_row', new.id);
END;--> statement-breakpoint
CREATE TRIGGER meeting_transcript_row_index_au AFTER UPDATE OF text ON meeting_transcript_rows
  WHEN old.text IS NOT new.text BEGIN
  INSERT OR IGNORE INTO meeting_index_pending (indexable_type, id) VALUES ('meeting_transcript_row', new.id);
END;--> statement-breakpoint
CREATE TRIGGER meeting_transcript_row_index_ad AFTER DELETE ON meeting_transcript_rows BEGIN
  INSERT OR IGNORE INTO meeting_index_pending (indexable_type, id) VALUES ('meeting_transcript_row', old.id);
END;--> statement-breakpoint
CREATE TRIGGER meeting_chat_message_index_ai AFTER INSERT ON meeting_chat_messages BEGIN
  INSERT OR IGNORE INTO meeting_index_pending (indexable_type, id) VALUES ('meeting_chat_message', new.id);
END;--> statement-breakpoint
CREATE TRIGGER meeting_chat_message_index_au AFTER UPDATE OF text ON meeting_chat_messages
  WHEN old.text IS NOT new.text BEGIN
  INSERT OR IGNORE INTO meeting_index_pending (indexable_type, id) VALUES ('meeting_chat_message', new.id);
END;--> statement-breakpoint
CREATE TRIGGER meeting_chat_message_index_ad AFTER DELETE ON meeting_chat_messages BEGIN
  INSERT OR IGNORE INTO meeting_index_pending (indexable_type, id) VALUES ('meeting_chat_message', old.id);
END;--> statement-breakpoint
CREATE TRIGGER meeting_summary_index_ai AFTER INSERT ON meeting_summaries BEGIN
  INSERT OR IGNORE INTO meeting_index_pending (indexable_type, id) VALUES ('meeting_summary', new.id);
END;--> statement-breakpoint
CREATE TRIGGER meeting_summary_index_au AFTER UPDATE OF title, overview, sections, next_steps, content ON meeting_summaries
  WHEN old.title IS NOT new.title OR old.overview IS NOT new.overview OR old.sections IS NOT new.sections
    OR old.next_steps IS NOT new.next_steps OR old.content IS NOT new.content BEGIN
  INSERT OR IGNORE INTO meeting_index_pending (indexable_type, id) VALUES ('meeting_summary', new.id);
END;--> statement-breakpoint
CREATE TRIGGER meeting_summary_index_ad AFTER DELETE ON meeting_summaries BEGIN
  INSERT OR IGNORE INTO meeting_index_pending (indexable_type, id) VALUES ('meeting_summary', old.id);
END;--> statement-breakpoint
-- Drizzle cannot declare WITHOUT ROWID, so the vocabulary is written here and not in schema.ts.
CREATE TABLE search_terms (
  term   TEXT PRIMARY KEY,
  length INTEGER NOT NULL
) WITHOUT ROWID;--> statement-breakpoint
CREATE TABLE search_term_trigrams (
  trigram TEXT NOT NULL,
  length  INTEGER NOT NULL,
  term    TEXT NOT NULL,
  PRIMARY KEY (trigram, length, term)
) WITHOUT ROWID;--> statement-breakpoint
-- A new file has nothing to fill: the words index is built at once. `analyzer` stays NULL until the first
-- drain claims it.
INSERT INTO search_index_state (name, watermark, filled_through, terms_through, normalizer_version, built_at, analyzer)
  VALUES ('message_words', 0, 0, 0, 1, CAST(unixepoch('subsec') * 1000 AS INTEGER), NULL),
         ('message_stems', 0, 0, 0, 1, NULL, NULL),
         ('note_index', 0, 0, 0, 1, NULL, NULL);
