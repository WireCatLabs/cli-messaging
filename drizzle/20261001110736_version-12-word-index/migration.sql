-- Words of the normalized text, ranked by bm25. Contentless with delete support: an index filled in
-- batches after its triggers exist stays consistent only this way (phase 2 plan, S1). `scope` holds
-- `c<chat_pk>` and `s<sender_identity_pk>` so a small chat or a sender is filtered inside the index.
CREATE VIRTUAL TABLE message_words USING fts5(
  normalized_text, scope,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2', prefix = '3');--> statement-breakpoint
-- 'col', not 'row': the scope tokens must never come back as a word or a correction.
CREATE VIRTUAL TABLE message_words_vocab USING fts5vocab(message_words, 'col');--> statement-breakpoint
CREATE TRIGGER message_words_ai AFTER INSERT ON messages WHEN new.normalized_text <> '' BEGIN
  INSERT INTO message_words (rowid, normalized_text, scope)
    VALUES (new.pk, new.normalized_text, 'c' || new.chat_pk || coalesce(' s' || new.sender_identity_pk, ''));
END;--> statement-breakpoint
-- Every re-save of a message sets these columns; only a real change may touch the index.
CREATE TRIGGER message_words_au AFTER UPDATE OF normalized_text, sender_identity_pk, chat_pk ON messages
  WHEN old.normalized_text IS NOT new.normalized_text
    OR old.sender_identity_pk IS NOT new.sender_identity_pk
    OR old.chat_pk IS NOT new.chat_pk BEGIN
  DELETE FROM message_words WHERE rowid = old.pk;
  INSERT INTO message_words (rowid, normalized_text, scope)
    SELECT new.pk, new.normalized_text, 'c' || new.chat_pk || coalesce(' s' || new.sender_identity_pk, '')
    WHERE new.normalized_text <> '';
END;--> statement-breakpoint
CREATE TRIGGER message_words_ad AFTER DELETE ON messages BEGIN
  DELETE FROM message_words WHERE rowid = old.pk;
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
-- 5,000 is BACKFILL_ON_OPEN and 1 is NORMALIZER_VERSION as of this version; a migration is frozen.
-- A larger file is filled up to the watermark in batches, outside this transaction.
INSERT INTO search_index_state (name, watermark, filled_through, terms_through, normalizer_version, built_at)
  SELECT 'message_words', coalesce(max(pk), 0),
    CASE WHEN count(*) <= 5000 THEN coalesce(max(pk), 0) ELSE 0 END,
    0, 1,
    CASE WHEN count(*) <= 5000 THEN CAST(unixepoch('subsec') * 1000 AS INTEGER) END
  FROM messages;--> statement-breakpoint
INSERT INTO message_words (rowid, normalized_text, scope)
  SELECT pk, normalized_text, 'c' || chat_pk || coalesce(' s' || sender_identity_pk, '')
  FROM messages
  WHERE normalized_text <> '' AND (SELECT count(*) FROM messages) <= 5000;
