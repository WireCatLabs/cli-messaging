CREATE TABLE `attachment_texts` (
	`attachment_pk` integer PRIMARY KEY,
	`text` text NOT NULL,
	`normalized_text` text NOT NULL,
	`origin` text NOT NULL,
	`extractor` text NOT NULL,
	`content_sha256` text,
	`bytes` integer,
	`error` text,
	`written_at` integer NOT NULL
);
