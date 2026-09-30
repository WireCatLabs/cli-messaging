CREATE TABLE `transcripts` (
	`chat_pk` integer NOT NULL,
	`message_native_id` text NOT NULL,
	`text` text NOT NULL,
	`source` text NOT NULL,
	`heard_at` integer NOT NULL,
	CONSTRAINT `transcripts_pk` PRIMARY KEY(`chat_pk`, `message_native_id`),
	CONSTRAINT `fk_transcripts_chat_pk_chats_pk_fk` FOREIGN KEY (`chat_pk`) REFERENCES `chats`(`pk`)
);
