CREATE TABLE `searches` (
	`pk` integer PRIMARY KEY,
	`name` text UNIQUE,
	`command` text NOT NULL,
	`params` text NOT NULL,
	`language` text NOT NULL,
	`version` integer NOT NULL,
	`fields_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`last_run_at` integer,
	`runs` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `searches_history` ON `searches` (`command`,`params`) WHERE name IS NULL;--> statement-breakpoint
CREATE INDEX `searches_by_last_run` ON `searches` ("last_run_at" desc);