ALTER TABLE `chats` ADD `username` text;--> statement-breakpoint
ALTER TABLE `chats` ADD `membership_state` text;--> statement-breakpoint
ALTER TABLE `chats` ADD `is_searchable` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `chats` ADD `message_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `normalized_text` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `normalizer_version` integer;--> statement-breakpoint
CREATE INDEX `messages_to_normalize` ON `messages` (`pk`) WHERE normalized_text IS NULL AND deleted_at IS NULL;