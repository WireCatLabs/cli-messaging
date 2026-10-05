-- Words of the attachments' text, rowid = attachment pk. Kept apart from message_words so `text:` stays
-- what was written and a file's words never rank a message (max-cli plan, file content search, D3 a).
CREATE VIRTUAL TABLE attachment_words USING fts5(
  normalized_text,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2');--> statement-breakpoint
CREATE TRIGGER attachment_words_ai AFTER INSERT ON attachment_texts WHEN new.normalized_text <> '' BEGIN
  INSERT INTO attachment_words (rowid, normalized_text) VALUES (new.attachment_pk, new.normalized_text);
END;--> statement-breakpoint
CREATE TRIGGER attachment_words_au AFTER UPDATE OF normalized_text ON attachment_texts
  WHEN old.normalized_text IS NOT new.normalized_text BEGIN
  DELETE FROM attachment_words WHERE rowid = old.attachment_pk;
  INSERT INTO attachment_words (rowid, normalized_text)
    SELECT new.attachment_pk, new.normalized_text WHERE new.normalized_text <> '';
END;--> statement-breakpoint
CREATE TRIGGER attachment_words_ad AFTER DELETE ON attachment_texts BEGIN
  DELETE FROM attachment_words WHERE rowid = old.attachment_pk;
END;--> statement-breakpoint
-- Triggers, not code, so a build pinned to an older package still erases a deleted message's file text.
CREATE TRIGGER attachment_texts_message_tombstone AFTER UPDATE OF deleted_at ON messages
  WHEN old.deleted_at IS NULL AND new.deleted_at IS NOT NULL BEGIN
  DELETE FROM attachment_texts WHERE attachment_pk IN (SELECT pk FROM attachments WHERE message_pk = new.pk);
END;--> statement-breakpoint
CREATE TRIGGER attachment_texts_message_ad AFTER DELETE ON messages BEGIN
  DELETE FROM attachment_texts WHERE attachment_pk IN (SELECT pk FROM attachments WHERE message_pk = old.pk);
END;--> statement-breakpoint
CREATE TRIGGER attachment_texts_attachment_ad AFTER DELETE ON attachments BEGIN
  DELETE FROM attachment_texts WHERE attachment_pk = old.pk;
END;
