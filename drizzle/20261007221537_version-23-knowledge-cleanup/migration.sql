-- Custom SQL migration file, put your code below! --
CREATE TRIGGER knowledge_account_delete BEFORE DELETE ON accounts BEGIN
  DELETE FROM tags WHERE taggable_type='knowledge' AND taggable_pk IN (SELECT pk FROM knowledge_targets WHERE account_pk=old.pk);
  DELETE FROM annotations WHERE target_type='source' AND account_pk=old.pk;
  DELETE FROM knowledge_relations WHERE account_pk=old.pk;
  DELETE FROM knowledge_reminders WHERE account_pk=old.pk;
  DELETE FROM knowledge_entities WHERE account_pk=old.pk;
  DELETE FROM knowledge_targets WHERE account_pk=old.pk;
END;
--> statement-breakpoint
CREATE TRIGGER knowledge_task_closed AFTER UPDATE OF state ON tasks WHEN new.state<>'open' BEGIN
  UPDATE knowledge_reminders SET state='cancelled',receipt=NULL,lease_until=NULL,revision=revision+1
  WHERE task_id=new.id AND state IN ('pending','leased');
END;
