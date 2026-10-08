CREATE TABLE `owner_targets` (
	`pk` integer PRIMARY KEY,
	`reference` text NOT NULL UNIQUE,
	`folder_id` text,
	`folder_path` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `owner_targets_by_folder` ON `owner_targets` (`folder_id`,`folder_path`);