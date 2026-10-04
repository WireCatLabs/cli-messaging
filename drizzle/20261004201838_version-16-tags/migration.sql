CREATE TABLE `tags` (
	`pk` integer PRIMARY KEY,
	`taggable_type` text NOT NULL,
	`taggable_pk` integer NOT NULL,
	`tag` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `tags_taggable_type_taggable_pk_tag_unique` UNIQUE(`taggable_type`,`taggable_pk`,`tag`)
);
--> statement-breakpoint
CREATE INDEX `tags_by_tag` ON `tags` (`tag`,`taggable_type`,`taggable_pk`);