CREATE TABLE `message_stems_pending` (
	`pk` integer PRIMARY KEY
);
--> statement-breakpoint
CREATE TABLE `store_settings` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `search_index_state` ADD `analyzer` text;