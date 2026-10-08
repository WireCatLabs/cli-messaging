CREATE TABLE `entities` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `links` (
	`id` text PRIMARY KEY,
	`from_ref` text NOT NULL,
	`to_ref` text,
	`kind` text NOT NULL,
	`anchor` text,
	`origin` text NOT NULL,
	`target_text` text,
	`target_folded` text,
	`role` text,
	`evidence` text,
	`provenance` text,
	`confirmed` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `note_folders` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`format` text NOT NULL,
	`pending_path` text,
	`account_pk` integer UNIQUE,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_note_folders_account_pk_accounts_pk_fk` FOREIGN KEY (`account_pk`) REFERENCES `accounts`(`pk`)
);
--> statement-breakpoint
CREATE TABLE `note_revisions` (
	`note_pk` integer NOT NULL,
	`text` text NOT NULL,
	`captured_at` integer NOT NULL,
	CONSTRAINT `fk_note_revisions_note_pk_notes_pk_fk` FOREIGN KEY (`note_pk`) REFERENCES `notes`(`pk`)
);
--> statement-breakpoint
CREATE TABLE `notes` (
	`pk` integer PRIMARY KEY,
	`id` text NOT NULL UNIQUE,
	`source` text NOT NULL,
	`folder_id` text,
	`path` text,
	`title` text,
	`text` text NOT NULL,
	`front_matter` text,
	`content_hash` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`export_path` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT `fk_notes_folder_id_note_folders_id_fk` FOREIGN KEY (`folder_id`) REFERENCES `note_folders`(`id`)
);
--> statement-breakpoint
CREATE INDEX `links_from` ON `links` (`from_ref`);--> statement-breakpoint
CREATE INDEX `links_to` ON `links` (`to_ref`);--> statement-breakpoint
CREATE INDEX `links_unresolved` ON `links` (`target_folded`) WHERE to_ref IS NULL;--> statement-breakpoint
CREATE INDEX `note_revisions_by_note` ON `note_revisions` (`note_pk`);--> statement-breakpoint
CREATE UNIQUE INDEX `notes_by_path` ON `notes` (`folder_id`,`path`);