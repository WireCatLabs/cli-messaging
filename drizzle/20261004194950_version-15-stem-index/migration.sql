-- Snowball stems of `messages.text`, shaped like `message_words` so its `scope` filter and bm25 weights
-- carry over. No prefix index: wildcards never read stems. SQL cannot stem — a UDF in a trigger would
-- break every older writer — so the triggers only queue the message, and JS writes the stems.
CREATE VIRTUAL TABLE message_stems USING fts5(
  stems, scope,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2');--> statement-breakpoint
CREATE TRIGGER message_stems_ai AFTER INSERT ON messages WHEN new.text <> '' BEGIN
  INSERT OR IGNORE INTO message_stems_pending (pk) VALUES (new.pk);
END;--> statement-breakpoint
CREATE TRIGGER message_stems_au AFTER UPDATE OF text, sender_identity_pk, chat_pk ON messages
  WHEN old.text IS NOT new.text
    OR old.sender_identity_pk IS NOT new.sender_identity_pk
    OR old.chat_pk IS NOT new.chat_pk BEGIN
  INSERT OR IGNORE INTO message_stems_pending (pk) VALUES (new.pk);
END;--> statement-breakpoint
CREATE TRIGGER message_stems_ad AFTER DELETE ON messages BEGIN
  DELETE FROM message_stems WHERE rowid = old.pk;
  DELETE FROM message_stems_pending WHERE pk = old.pk;
END;--> statement-breakpoint
-- 1 is NORMALIZER_VERSION as of this version; a migration is frozen. Every file starts unbuilt
-- (analyzer NULL): the first JS fill claims the row with its analyzer and fills up to the watermark.
INSERT INTO search_index_state (name, watermark, filled_through, terms_through, normalizer_version, analyzer)
  SELECT 'message_stems', coalesce(max(pk), 0), 0, 0, 1, NULL FROM messages;
