CREATE TABLE `tasks` (
	`id` text PRIMARY KEY,
	`source` text NOT NULL,
	`source_kind` text NOT NULL,
	`account` text NOT NULL,
	`group_key` text NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`reason` text,
	`origin` text NOT NULL,
	`created_at` integer NOT NULL,
	`due_at` integer,
	`closed_at` integer,
	`closed_by` text
);
--> statement-breakpoint
CREATE INDEX `tasks_by_source` ON `tasks` (`account`,`source`);--> statement-breakpoint
CREATE INDEX `tasks_by_state` ON `tasks` (`account`,`state`,`group_key`);