-- The same words and stems indexes messages have, for notes. Written by JS from a queue, not by triggers:
-- the words are normalized and the stems computed in JS, and every writer of `notes` only has to enqueue.
CREATE VIRTUAL TABLE note_words USING fts5(
  normalized_text, scope,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2', prefix = '3');--> statement-breakpoint
CREATE VIRTUAL TABLE note_words_vocab USING fts5vocab(note_words, 'col');--> statement-breakpoint
CREATE VIRTUAL TABLE note_stems USING fts5(
  stems, scope,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2');--> statement-breakpoint
CREATE TABLE note_index_pending (pk INTEGER PRIMARY KEY);--> statement-breakpoint
CREATE TRIGGER note_index_ai AFTER INSERT ON notes BEGIN
  INSERT OR IGNORE INTO note_index_pending (pk) VALUES (new.pk);
END;--> statement-breakpoint
CREATE TRIGGER note_index_au AFTER UPDATE OF title, text, deleted_at, folder_id, source ON notes
  WHEN old.title IS NOT new.title OR old.text IS NOT new.text OR old.deleted_at IS NOT new.deleted_at
    OR old.folder_id IS NOT new.folder_id OR old.source IS NOT new.source BEGIN
  INSERT OR IGNORE INTO note_index_pending (pk) VALUES (new.pk);
END;--> statement-breakpoint
-- A vector is keyed by text alone, so it goes only when no other note or conversation chunk still uses it.
CREATE TRIGGER note_index_bd BEFORE DELETE ON notes BEGIN
  DELETE FROM chunk_vectors WHERE content_hash IN (
    SELECT k.content_hash FROM note_chunks k WHERE k.note_pk = old.pk
      AND NOT EXISTS (SELECT 1 FROM note_chunks o WHERE o.content_hash = k.content_hash AND o.note_pk <> old.pk)
      AND NOT EXISTS (SELECT 1 FROM conversation_chunks c WHERE c.content_hash = k.content_hash));
  DELETE FROM note_words WHERE rowid = old.pk;
  DELETE FROM note_stems WHERE rowid = old.pk;
  DELETE FROM note_index_pending WHERE pk = old.pk;
END;--> statement-breakpoint
-- `analyzer` stays NULL until the first drain claims it; a different one later re-queues every note.
INSERT INTO search_index_state (name, watermark, filled_through, terms_through, normalizer_version, built_at)
  VALUES ('note_index', 0, 0, 0, 1, NULL);--> statement-breakpoint
INSERT OR IGNORE INTO note_index_pending (pk) SELECT pk FROM notes;
