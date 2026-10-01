CREATE TABLE `search_index_state` (
	`name` text PRIMARY KEY,
	`watermark` integer NOT NULL,
	`filled_through` integer NOT NULL,
	`terms_through` integer NOT NULL,
	`normalizer_version` integer NOT NULL,
	`built_at` integer
);
