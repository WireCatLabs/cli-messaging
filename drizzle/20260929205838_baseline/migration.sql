CREATE TABLE `account_identities` (
	`account_pk` integer NOT NULL,
	`identity_pk` integer NOT NULL,
	`first_seen_at` integer NOT NULL,
	CONSTRAINT `account_identities_pk` PRIMARY KEY(`account_pk`, `identity_pk`),
	CONSTRAINT `fk_account_identities_account_pk_accounts_pk_fk` FOREIGN KEY (`account_pk`) REFERENCES `accounts`(`pk`),
	CONSTRAINT `fk_account_identities_identity_pk_identities_pk_fk` FOREIGN KEY (`identity_pk`) REFERENCES `identities`(`pk`)
);
--> statement-breakpoint
CREATE TABLE `accounts` (
	`pk` integer PRIMARY KEY,
	`provider` text NOT NULL,
	`native_id` text NOT NULL,
	`name` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `accounts_provider_native_id_unique` UNIQUE(`provider`,`native_id`)
);
--> statement-breakpoint
CREATE TABLE `attachments` (
	`pk` integer PRIMARY KEY,
	`message_pk` integer NOT NULL,
	`position` integer NOT NULL,
	`kind` text NOT NULL,
	`mime` text,
	`name` text,
	`title` text,
	`url` text,
	`size` integer,
	`width` integer,
	`height` integer,
	`duration` real,
	`provider_ref` text,
	`local_path` text,
	CONSTRAINT `fk_attachments_message_pk_messages_pk_fk` FOREIGN KEY (`message_pk`) REFERENCES `messages`(`pk`),
	CONSTRAINT `attachments_message_pk_position_unique` UNIQUE(`message_pk`,`position`)
);
--> statement-breakpoint
CREATE TABLE `chats` (
	`pk` integer PRIMARY KEY,
	`account_pk` integer NOT NULL,
	`native_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text,
	`unread_count` integer,
	`last_message_at` integer,
	`participants_count` integer,
	`provider_metadata` text,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_chats_account_pk_accounts_pk_fk` FOREIGN KEY (`account_pk`) REFERENCES `accounts`(`pk`),
	CONSTRAINT `chats_account_pk_native_id_unique` UNIQUE(`account_pk`,`native_id`)
);
--> statement-breakpoint
CREATE TABLE `identities` (
	`pk` integer PRIMARY KEY,
	`provider` text NOT NULL,
	`native_id` text NOT NULL,
	`username` text,
	`name` text,
	`is_bot` integer,
	`phone_hmac` text,
	`provider_metadata` text,
	`first_seen_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `identities_provider_native_id_unique` UNIQUE(`provider`,`native_id`)
);
--> statement-breakpoint
CREATE TABLE `identity_link_events` (
	`pk` integer PRIMARY KEY,
	`identity_pk` integer NOT NULL,
	`from_person_pk` integer,
	`to_person_pk` integer NOT NULL,
	`method` text NOT NULL,
	`at` integer NOT NULL,
	`by` text NOT NULL,
	CONSTRAINT `fk_identity_link_events_identity_pk_identities_pk_fk` FOREIGN KEY (`identity_pk`) REFERENCES `identities`(`pk`),
	CONSTRAINT `fk_identity_link_events_from_person_pk_persons_pk_fk` FOREIGN KEY (`from_person_pk`) REFERENCES `persons`(`pk`),
	CONSTRAINT `fk_identity_link_events_to_person_pk_persons_pk_fk` FOREIGN KEY (`to_person_pk`) REFERENCES `persons`(`pk`)
);
--> statement-breakpoint
CREATE TABLE `identity_links` (
	`identity_pk` integer PRIMARY KEY,
	`person_pk` integer NOT NULL,
	`method` text NOT NULL,
	`confidence` real NOT NULL,
	`linked_at` integer NOT NULL,
	`linked_by` text NOT NULL,
	CONSTRAINT `fk_identity_links_identity_pk_identities_pk_fk` FOREIGN KEY (`identity_pk`) REFERENCES `identities`(`pk`),
	CONSTRAINT `fk_identity_links_person_pk_persons_pk_fk` FOREIGN KEY (`person_pk`) REFERENCES `persons`(`pk`)
);
--> statement-breakpoint
CREATE TABLE `message_revisions` (
	`message_pk` integer NOT NULL,
	`text` text NOT NULL,
	`edited_at` integer,
	`captured_at` integer NOT NULL,
	CONSTRAINT `fk_message_revisions_message_pk_messages_pk_fk` FOREIGN KEY (`message_pk`) REFERENCES `messages`(`pk`)
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`pk` integer PRIMARY KEY,
	`chat_pk` integer NOT NULL,
	`account_pk` integer NOT NULL,
	`native_id` text NOT NULL,
	`thread_native_id` text,
	`sender_identity_pk` integer,
	`sender_chat_native_id` text,
	`sender_name` text,
	`sent_at` integer NOT NULL,
	`edited_at` integer,
	`deleted_at` integer,
	`text` text NOT NULL,
	`reply_to_native_id` text,
	`reply_to` text,
	`forward` text,
	`outgoing` integer,
	`reactions` text,
	`provider_metadata` text,
	`ingested_at` integer NOT NULL,
	`ingested_via` text NOT NULL,
	CONSTRAINT `fk_messages_chat_pk_chats_pk_fk` FOREIGN KEY (`chat_pk`) REFERENCES `chats`(`pk`),
	CONSTRAINT `fk_messages_account_pk_accounts_pk_fk` FOREIGN KEY (`account_pk`) REFERENCES `accounts`(`pk`),
	CONSTRAINT `fk_messages_sender_identity_pk_identities_pk_fk` FOREIGN KEY (`sender_identity_pk`) REFERENCES `identities`(`pk`),
	CONSTRAINT `messages_chat_pk_native_id_unique` UNIQUE(`chat_pk`,`native_id`)
);
--> statement-breakpoint
CREATE TABLE `persons` (
	`pk` integer PRIMARY KEY,
	`uid` text NOT NULL UNIQUE,
	`name` text,
	`is_self` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_ranges` (
	`chat_pk` integer NOT NULL,
	`from_key` integer NOT NULL,
	`to_key` integer NOT NULL,
	CONSTRAINT `sync_ranges_pk` PRIMARY KEY(`chat_pk`, `from_key`),
	CONSTRAINT `fk_sync_ranges_chat_pk_chats_pk_fk` FOREIGN KEY (`chat_pk`) REFERENCES `chats`(`pk`)
);
--> statement-breakpoint
CREATE INDEX `chats_by_recency` ON `chats` (`account_pk`,"last_message_at" desc);--> statement-breakpoint
CREATE INDEX `identity_links_by_person` ON `identity_links` (`person_pk`);--> statement-breakpoint
CREATE INDEX `revisions_by_message` ON `message_revisions` (`message_pk`);--> statement-breakpoint
CREATE INDEX `messages_by_time` ON `messages` (`chat_pk`,"sent_at" desc);--> statement-breakpoint
CREATE INDEX `messages_by_account` ON `messages` (`account_pk`,`native_id`);--> statement-breakpoint
CREATE INDEX `messages_by_sender` ON `messages` (`sender_identity_pk`);