CREATE TABLE `conversation_messages` (
	`conversation_pk` integer NOT NULL,
	`message_pk` integer NOT NULL,
	CONSTRAINT `conversation_messages_pk` PRIMARY KEY(`conversation_pk`, `message_pk`),
	CONSTRAINT `fk_conversation_messages_conversation_pk_conversations_pk_fk` FOREIGN KEY (`conversation_pk`) REFERENCES `conversations`(`pk`) ON DELETE CASCADE,
	CONSTRAINT `fk_conversation_messages_message_pk_messages_pk_fk` FOREIGN KEY (`message_pk`) REFERENCES `messages`(`pk`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `conversation_state` (
	`chat_pk` integer PRIMARY KEY,
	`enabled_at` integer NOT NULL,
	`built_at` integer,
	`algorithm_version` integer,
	`current_build` integer,
	CONSTRAINT `fk_conversation_state_chat_pk_chats_pk_fk` FOREIGN KEY (`chat_pk`) REFERENCES `chats`(`pk`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`pk` integer PRIMARY KEY,
	`chat_pk` integer NOT NULL,
	`first_message_pk` integer NOT NULL,
	`build` integer NOT NULL,
	`first_at` integer NOT NULL,
	`last_at` integer NOT NULL,
	`message_count` integer NOT NULL,
	`built_at` integer NOT NULL,
	`algorithm_version` integer NOT NULL,
	CONSTRAINT `fk_conversations_chat_pk_chats_pk_fk` FOREIGN KEY (`chat_pk`) REFERENCES `chats`(`pk`) ON DELETE CASCADE,
	CONSTRAINT `fk_conversations_first_message_pk_messages_pk_fk` FOREIGN KEY (`first_message_pk`) REFERENCES `messages`(`pk`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `message_links` (
	`chat_pk` integer NOT NULL,
	`message_pk` integer NOT NULL,
	`parent_pk` integer,
	`source` text NOT NULL,
	`kind` text NOT NULL,
	`confidence` real NOT NULL,
	`method` text NOT NULL,
	`version` text,
	`batch` text,
	`build` integer,
	`created_at` integer NOT NULL,
	`stale_at` integer,
	CONSTRAINT `fk_message_links_chat_pk_chats_pk_fk` FOREIGN KEY (`chat_pk`) REFERENCES `chats`(`pk`) ON DELETE CASCADE,
	CONSTRAINT `fk_message_links_message_pk_messages_pk_fk` FOREIGN KEY (`message_pk`) REFERENCES `messages`(`pk`) ON DELETE CASCADE,
	CONSTRAINT `fk_message_links_parent_pk_messages_pk_fk` FOREIGN KEY (`parent_pk`) REFERENCES `messages`(`pk`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `messages` ADD `mentions` text;--> statement-breakpoint
CREATE INDEX `conversation_messages_by_message` ON `conversation_messages` (`message_pk`);--> statement-breakpoint
CREATE INDEX `conversations_by_chat` ON `conversations` (`chat_pk`,`build`,`first_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `message_links_unique` ON `message_links` (`message_pk`,ifnull("parent_pk", 0),`source`,`kind`,ifnull("build", 0));--> statement-breakpoint
CREATE INDEX `message_links_by_parent` ON `message_links` (`parent_pk`);--> statement-breakpoint
CREATE INDEX `message_links_by_build` ON `message_links` (`chat_pk`,`build`);