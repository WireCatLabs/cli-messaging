CREATE TABLE `sync_state` (
	`account_pk` integer NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`at` integer NOT NULL,
	CONSTRAINT `sync_state_pk` PRIMARY KEY(`account_pk`, `key`),
	CONSTRAINT `fk_sync_state_account_pk_accounts_pk_fk` FOREIGN KEY (`account_pk`) REFERENCES `accounts`(`pk`)
);
