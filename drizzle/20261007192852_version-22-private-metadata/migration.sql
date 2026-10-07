CREATE TABLE `annotations` (
	`uid` text PRIMARY KEY,
	`account_pk` integer NOT NULL,
	`target_type` text NOT NULL,
	`target_pk` integer NOT NULL,
	`text` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`authored_by` text NOT NULL,
	CONSTRAINT `fk_annotations_account_pk_accounts_pk_fk` FOREIGN KEY (`account_pk`) REFERENCES `accounts`(`pk`)
);
--> statement-breakpoint
CREATE TABLE `auto_tag_claims` (
	`chat_pk` integer NOT NULL,
	`tag` text NOT NULL,
	`algorithm` text NOT NULL,
	`score` real NOT NULL,
	`fields` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `auto_tag_claims_pk` PRIMARY KEY(`chat_pk`, `tag`),
	CONSTRAINT `fk_auto_tag_claims_chat_pk_chats_pk_fk` FOREIGN KEY (`chat_pk`) REFERENCES `chats`(`pk`)
);
--> statement-breakpoint
CREATE TABLE `chat_metadata` (
	`chat_pk` integer PRIMARY KEY,
	`title` text,
	`username` text,
	`description` text,
	`fetched_at` integer NOT NULL,
	CONSTRAINT `fk_chat_metadata_chat_pk_chats_pk_fk` FOREIGN KEY (`chat_pk`) REFERENCES `chats`(`pk`)
);
--> statement-breakpoint
CREATE TABLE `contact_aliases` (
	`account_pk` integer NOT NULL,
	`identity_pk` integer NOT NULL,
	`alias` text,
	`updated_at` integer NOT NULL,
	CONSTRAINT `contact_aliases_pk` PRIMARY KEY(`account_pk`, `identity_pk`),
	CONSTRAINT `fk_contact_aliases_account_pk_accounts_pk_fk` FOREIGN KEY (`account_pk`) REFERENCES `accounts`(`pk`),
	CONSTRAINT `fk_contact_aliases_identity_pk_identities_pk_fk` FOREIGN KEY (`identity_pk`) REFERENCES `identities`(`pk`)
);
--> statement-breakpoint
CREATE INDEX `annotations_by_target` ON `annotations` (`account_pk`,`target_type`,`target_pk`);