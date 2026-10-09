DELETE FROM tags WHERE taggable_type = 'knowledge';
--> statement-breakpoint
DELETE FROM annotations;
--> statement-breakpoint
DELETE FROM knowledge_relations;
--> statement-breakpoint
DELETE FROM knowledge_entities;
--> statement-breakpoint
DELETE FROM knowledge_targets;
--> statement-breakpoint
DROP TRIGGER IF EXISTS knowledge_account_delete;
--> statement-breakpoint
CREATE TRIGGER knowledge_account_delete BEFORE DELETE ON accounts BEGIN
  DELETE FROM knowledge_reminders WHERE account_pk=old.pk;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS private_metadata_account_delete;
--> statement-breakpoint
CREATE TRIGGER private_metadata_account_delete BEFORE DELETE ON accounts BEGIN
  DELETE FROM contact_aliases WHERE account_pk=old.pk;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS private_metadata_chat_delete;
--> statement-breakpoint
CREATE TRIGGER private_metadata_chat_delete BEFORE DELETE ON chats BEGIN
  DELETE FROM chat_metadata WHERE chat_pk=old.pk;
  DELETE FROM auto_tag_claims WHERE chat_pk=old.pk;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS private_metadata_identity_delete;
--> statement-breakpoint
CREATE TRIGGER private_metadata_identity_delete BEFORE DELETE ON identities BEGIN
  DELETE FROM contact_aliases WHERE identity_pk=old.pk;
END;
--> statement-breakpoint
DELETE FROM message_revisions WHERE message_pk IN (SELECT m.pk FROM messages m JOIN accounts a ON a.pk = m.account_pk WHERE a.provider = 'notes');
--> statement-breakpoint
DELETE FROM attachments WHERE message_pk IN (SELECT m.pk FROM messages m JOIN accounts a ON a.pk = m.account_pk WHERE a.provider = 'notes');
--> statement-breakpoint
DELETE FROM messages WHERE account_pk IN (SELECT pk FROM accounts WHERE provider = 'notes');
--> statement-breakpoint
DELETE FROM sync_ranges WHERE chat_pk IN (SELECT c.pk FROM chats c JOIN accounts a ON a.pk = c.account_pk WHERE a.provider = 'notes');
--> statement-breakpoint
DELETE FROM fetch_leases WHERE chat_pk IN (SELECT c.pk FROM chats c JOIN accounts a ON a.pk = c.account_pk WHERE a.provider = 'notes');
--> statement-breakpoint
DELETE FROM transcripts WHERE chat_pk IN (SELECT c.pk FROM chats c JOIN accounts a ON a.pk = c.account_pk WHERE a.provider = 'notes');
--> statement-breakpoint
DELETE FROM chat_members WHERE chat_pk IN (SELECT c.pk FROM chats c JOIN accounts a ON a.pk = c.account_pk WHERE a.provider = 'notes');
--> statement-breakpoint
DELETE FROM member_stays WHERE chat_pk IN (SELECT c.pk FROM chats c JOIN accounts a ON a.pk = c.account_pk WHERE a.provider = 'notes');
--> statement-breakpoint
DELETE FROM member_counts WHERE chat_pk IN (SELECT c.pk FROM chats c JOIN accounts a ON a.pk = c.account_pk WHERE a.provider = 'notes');
--> statement-breakpoint
DELETE FROM chats WHERE account_pk IN (SELECT pk FROM accounts WHERE provider = 'notes');
--> statement-breakpoint
DELETE FROM sync_state WHERE account_pk IN (SELECT pk FROM accounts WHERE provider = 'notes');
--> statement-breakpoint
DELETE FROM account_identities WHERE account_pk IN (SELECT pk FROM accounts WHERE provider = 'notes');
--> statement-breakpoint
DELETE FROM accounts WHERE provider = 'notes';
--> statement-breakpoint
DELETE FROM store_settings WHERE key IN ('notesCopiedThroughMessage', 'ownerTargetsCopied');
