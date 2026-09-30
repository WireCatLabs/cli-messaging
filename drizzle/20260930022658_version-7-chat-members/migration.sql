CREATE TABLE `chat_members` (
	`chat_pk` integer NOT NULL,
	`identity_pk` integer NOT NULL,
	CONSTRAINT `chat_members_pk` PRIMARY KEY(`chat_pk`, `identity_pk`),
	CONSTRAINT `fk_chat_members_chat_pk_chats_pk_fk` FOREIGN KEY (`chat_pk`) REFERENCES `chats`(`pk`),
	CONSTRAINT `fk_chat_members_identity_pk_identities_pk_fk` FOREIGN KEY (`identity_pk`) REFERENCES `identities`(`pk`)
);
--> statement-breakpoint
CREATE INDEX `chat_members_by_identity` ON `chat_members` (`identity_pk`);