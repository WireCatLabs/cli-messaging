CREATE TABLE `chunk_vectors` (
	`model` text NOT NULL,
	`content_hash` text NOT NULL,
	`dims` integer NOT NULL,
	`vector` blob NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `chunk_vectors_pk` PRIMARY KEY(`model`, `content_hash`)
);
--> statement-breakpoint
CREATE TABLE `conversation_chunks` (
	`conversation_pk` integer NOT NULL,
	`ordinal` integer NOT NULL,
	`first_message_pk` integer NOT NULL,
	`last_message_pk` integer NOT NULL,
	`content_hash` text NOT NULL,
	CONSTRAINT `conversation_chunks_pk` PRIMARY KEY(`conversation_pk`, `ordinal`),
	CONSTRAINT `fk_conversation_chunks_conversation_pk_conversations_pk_fk` FOREIGN KEY (`conversation_pk`) REFERENCES `conversations`(`pk`) ON DELETE CASCADE,
	CONSTRAINT `fk_conversation_chunks_first_message_pk_messages_pk_fk` FOREIGN KEY (`first_message_pk`) REFERENCES `messages`(`pk`) ON DELETE CASCADE,
	CONSTRAINT `fk_conversation_chunks_last_message_pk_messages_pk_fk` FOREIGN KEY (`last_message_pk`) REFERENCES `messages`(`pk`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `conversation_chunks_by_hash` ON `conversation_chunks` (`content_hash`);