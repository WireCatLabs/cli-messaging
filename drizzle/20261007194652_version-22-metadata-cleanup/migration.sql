CREATE TRIGGER private_metadata_chat_delete BEFORE DELETE ON chats BEGIN
  DELETE FROM chat_metadata WHERE chat_pk=old.pk;
  DELETE FROM auto_tag_claims WHERE chat_pk=old.pk;
  DELETE FROM annotations WHERE target_type='chat' AND target_pk=old.pk;
END;
--> statement-breakpoint
CREATE TRIGGER private_metadata_identity_delete BEFORE DELETE ON identities BEGIN
  DELETE FROM contact_aliases WHERE identity_pk=old.pk;
  DELETE FROM annotations WHERE target_type='contact' AND target_pk=old.pk;
END;
--> statement-breakpoint
CREATE TRIGGER private_metadata_account_delete BEFORE DELETE ON accounts BEGIN
  DELETE FROM contact_aliases WHERE account_pk=old.pk;
  DELETE FROM annotations WHERE account_pk=old.pk;
END;
