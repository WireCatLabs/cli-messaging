CREATE TABLE `knowledge_entities` (
	`uid` text PRIMARY KEY,
	`account_pk` integer NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_knowledge_entities_account_pk_accounts_pk_fk` FOREIGN KEY (`account_pk`) REFERENCES `accounts`(`pk`)
);
--> statement-breakpoint
CREATE TABLE `knowledge_relations` (
	`uid` text PRIMARY KEY,
	`account_pk` integer NOT NULL,
	`from_ref` text NOT NULL,
	`to_ref` text NOT NULL,
	`kind` text NOT NULL,
	`role` text,
	`evidence` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_knowledge_relations_account_pk_accounts_pk_fk` FOREIGN KEY (`account_pk`) REFERENCES `accounts`(`pk`)
);
--> statement-breakpoint
CREATE TABLE `knowledge_reminders` (
	`uid` text PRIMARY KEY,
	`account_pk` integer NOT NULL,
	`task_id` text NOT NULL,
	`due_at` integer NOT NULL,
	`timezone` text NOT NULL,
	`state` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`lease_until` integer,
	`receipt` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_knowledge_reminders_account_pk_accounts_pk_fk` FOREIGN KEY (`account_pk`) REFERENCES `accounts`(`pk`)
);
--> statement-breakpoint
CREATE TABLE `knowledge_targets` (
	`pk` integer PRIMARY KEY AUTOINCREMENT,
	`account_pk` integer NOT NULL,
	`type` text NOT NULL,
	`reference` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_knowledge_targets_account_pk_accounts_pk_fk` FOREIGN KEY (`account_pk`) REFERENCES `accounts`(`pk`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_relation_identity` ON `knowledge_relations` (`account_pk`,`from_ref`,`to_ref`,`kind`);--> statement-breakpoint
CREATE INDEX `knowledge_reminders_due` ON `knowledge_reminders` (`account_pk`,`state`,`due_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_target_identity` ON `knowledge_targets` (`account_pk`,`type`,`reference`);