-- A tag or an outgoing link has no foreign key to cascade by: these keep them from outliving their note.
CREATE TRIGGER notes_tombstone AFTER UPDATE OF deleted_at ON notes
  WHEN old.deleted_at IS NULL AND new.deleted_at IS NOT NULL BEGIN
  DELETE FROM tags WHERE taggable_type = 'note' AND taggable_pk = new.pk;
END;--> statement-breakpoint
CREATE TRIGGER notes_bd BEFORE DELETE ON notes BEGIN
  DELETE FROM tags WHERE taggable_type = 'note' AND taggable_pk = old.pk;
  DELETE FROM note_revisions WHERE note_pk = old.pk;
  DELETE FROM links WHERE from_ref = 'note:' || old.id;
END;--> statement-breakpoint
CREATE TRIGGER note_folders_account_bd BEFORE DELETE ON accounts BEGIN
  UPDATE note_folders SET account_pk = NULL WHERE account_pk = old.pk;
END;
