CREATE TABLE `fetch_leases` (
	`chat_pk` integer NOT NULL,
	`anchor` text NOT NULL,
	`holder` text NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT `fetch_leases_pk` PRIMARY KEY(`chat_pk`, `anchor`),
	CONSTRAINT `fk_fetch_leases_chat_pk_chats_pk_fk` FOREIGN KEY (`chat_pk`) REFERENCES `chats`(`pk`)
);
