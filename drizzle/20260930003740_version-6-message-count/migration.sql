-- A chat's live messages, kept by triggers: a tombstone is not counted, and taking it back is.
CREATE TRIGGER chats_count_ai AFTER INSERT ON messages WHEN new.deleted_at IS NULL BEGIN
  UPDATE chats SET message_count = message_count + 1 WHERE pk = new.chat_pk;
END;--> statement-breakpoint
CREATE TRIGGER chats_count_ad AFTER DELETE ON messages WHEN old.deleted_at IS NULL BEGIN
  UPDATE chats SET message_count = message_count - 1 WHERE pk = old.chat_pk;
END;--> statement-breakpoint
CREATE TRIGGER chats_count_tombstone AFTER UPDATE OF deleted_at ON messages
  WHEN old.deleted_at IS NULL AND new.deleted_at IS NOT NULL BEGIN
  UPDATE chats SET message_count = message_count - 1 WHERE pk = new.chat_pk;
END;--> statement-breakpoint
CREATE TRIGGER chats_count_untombstone AFTER UPDATE OF deleted_at ON messages
  WHEN old.deleted_at IS NOT NULL AND new.deleted_at IS NULL BEGIN
  UPDATE chats SET message_count = message_count + 1 WHERE pk = new.chat_pk;
END;--> statement-breakpoint
UPDATE chats SET message_count = counted.n
  FROM (SELECT chat_pk, count(*) AS n FROM messages WHERE deleted_at IS NULL GROUP BY chat_pk) AS counted
  WHERE chats.pk = counted.chat_pk;
