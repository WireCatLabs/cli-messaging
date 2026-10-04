CREATE TABLE `identity_revisions` (
	`pk` integer PRIMARY KEY,
	`identity_pk` integer NOT NULL,
	`name` text,
	`username` text,
	`description` text,
	`marks` text,
	`captured_at` integer NOT NULL,
	CONSTRAINT `fk_identity_revisions_identity_pk_identities_pk_fk` FOREIGN KEY (`identity_pk`) REFERENCES `identities`(`pk`)
);
--> statement-breakpoint
CREATE TABLE `member_counts` (
	`chat_pk` integer NOT NULL,
	`day` text NOT NULL,
	`participants` integer,
	`listed` integer NOT NULL,
	`complete` integer NOT NULL,
	`at` integer NOT NULL,
	CONSTRAINT `member_counts_pk` PRIMARY KEY(`chat_pk`, `day`),
	CONSTRAINT `fk_member_counts_chat_pk_chats_pk_fk` FOREIGN KEY (`chat_pk`) REFERENCES `chats`(`pk`)
);
--> statement-breakpoint
CREATE TABLE `member_stays` (
	`pk` integer PRIMARY KEY,
	`chat_pk` integer NOT NULL,
	`identity_pk` integer NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`joined_at` integer,
	`invited_by_pk` integer,
	`role` text,
	`gone_at` integer,
	CONSTRAINT `fk_member_stays_chat_pk_chats_pk_fk` FOREIGN KEY (`chat_pk`) REFERENCES `chats`(`pk`),
	CONSTRAINT `fk_member_stays_identity_pk_identities_pk_fk` FOREIGN KEY (`identity_pk`) REFERENCES `identities`(`pk`),
	CONSTRAINT `fk_member_stays_invited_by_pk_identities_pk_fk` FOREIGN KEY (`invited_by_pk`) REFERENCES `identities`(`pk`)
);
--> statement-breakpoint
ALTER TABLE `chats` ADD `members_tracked_at` integer;--> statement-breakpoint
CREATE INDEX `identity_revisions_by_identity` ON `identity_revisions` (`identity_pk`,`captured_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `member_stays_open` ON `member_stays` (`chat_pk`,`identity_pk`) WHERE gone_at IS NULL;--> statement-breakpoint
CREATE INDEX `member_stays_by_identity` ON `member_stays` (`identity_pk`);