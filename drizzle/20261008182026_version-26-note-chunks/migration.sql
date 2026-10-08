CREATE TABLE `note_chunks` (
	`note_pk` integer NOT NULL,
	`seq` integer NOT NULL,
	`text_start` integer NOT NULL,
	`text_end` integer NOT NULL,
	`content_hash` text NOT NULL,
	CONSTRAINT `note_chunks_pk` PRIMARY KEY(`note_pk`, `seq`),
	CONSTRAINT `fk_note_chunks_note_pk_notes_pk_fk` FOREIGN KEY (`note_pk`) REFERENCES `notes`(`pk`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `note_chunks_by_hash` ON `note_chunks` (`content_hash`);