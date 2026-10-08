CREATE TABLE `membership_batch_members` (
	`batch_pk` integer NOT NULL,
	`identity_pk` integer NOT NULL,
	`stay_pk` integer NOT NULL,
	CONSTRAINT `membership_batch_members_pk` PRIMARY KEY(`batch_pk`, `identity_pk`),
	CONSTRAINT `fk_membership_batch_members_batch_pk_membership_batches_pk_fk` FOREIGN KEY (`batch_pk`) REFERENCES `membership_batches`(`pk`) ON DELETE CASCADE,
	CONSTRAINT `fk_membership_batch_members_identity_pk_identities_pk_fk` FOREIGN KEY (`identity_pk`) REFERENCES `identities`(`pk`) ON DELETE CASCADE,
	CONSTRAINT `fk_membership_batch_members_stay_pk_member_stays_pk_fk` FOREIGN KEY (`stay_pk`) REFERENCES `member_stays`(`pk`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `membership_batches` (
	`pk` integer PRIMARY KEY,
	`chat_pk` integer NOT NULL,
	`observed_at` integer NOT NULL,
	`started_at` integer,
	`complete` integer NOT NULL,
	`participants` integer,
	`listed` integer NOT NULL,
	`source` text NOT NULL,
	CONSTRAINT `fk_membership_batches_chat_pk_chats_pk_fk` FOREIGN KEY (`chat_pk`) REFERENCES `chats`(`pk`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `message_counter_observations` (
	`message_pk` integer NOT NULL,
	`counter` text NOT NULL,
	`value` real NOT NULL,
	`observed_at` integer NOT NULL,
	`source` text NOT NULL,
	CONSTRAINT `message_counter_observations_pk` PRIMARY KEY(`message_pk`, `counter`),
	CONSTRAINT `fk_message_counter_observations_message_pk_messages_pk_fk` FOREIGN KEY (`message_pk`) REFERENCES `messages`(`pk`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `membership_members_by_stay` ON `membership_batch_members` (`stay_pk`,`batch_pk`);--> statement-breakpoint
CREATE INDEX `membership_batches_by_chat_time` ON `membership_batches` (`chat_pk`,`observed_at`);