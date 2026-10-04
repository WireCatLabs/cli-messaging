-- A tag has no foreign key to cascade by: these keep a deleted message's or chat's tags from outliving it.
CREATE TRIGGER tags_message_tombstone AFTER UPDATE OF deleted_at ON messages
  WHEN old.deleted_at IS NULL AND new.deleted_at IS NOT NULL BEGIN
  DELETE FROM tags WHERE taggable_type = 'message' AND taggable_pk = new.pk;
END;--> statement-breakpoint
CREATE TRIGGER tags_message_ad AFTER DELETE ON messages BEGIN
  DELETE FROM tags WHERE taggable_type = 'message' AND taggable_pk = old.pk;
END;--> statement-breakpoint
CREATE TRIGGER tags_chat_ad AFTER DELETE ON chats BEGIN
  DELETE FROM tags WHERE taggable_type = 'chat' AND taggable_pk = old.pk;
END;
