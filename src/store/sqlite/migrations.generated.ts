// Written by scripts/bundle-migrations.ts from drizzle/ — run `pnpm db:bundle`, do not edit.
export const GENERATED: { name: string; statements: string[] }[] = [
  {
    "name": "20260929205838_baseline",
    "statements": [
      "CREATE TABLE `account_identities` (\n\t`account_pk` integer NOT NULL,\n\t`identity_pk` integer NOT NULL,\n\t`first_seen_at` integer NOT NULL,\n\tCONSTRAINT `account_identities_pk` PRIMARY KEY(`account_pk`, `identity_pk`),\n\tCONSTRAINT `fk_account_identities_account_pk_accounts_pk_fk` FOREIGN KEY (`account_pk`) REFERENCES `accounts`(`pk`),\n\tCONSTRAINT `fk_account_identities_identity_pk_identities_pk_fk` FOREIGN KEY (`identity_pk`) REFERENCES `identities`(`pk`)\n);",
      "CREATE TABLE `accounts` (\n\t`pk` integer PRIMARY KEY,\n\t`provider` text NOT NULL,\n\t`native_id` text NOT NULL,\n\t`name` text,\n\t`created_at` integer NOT NULL,\n\tCONSTRAINT `accounts_provider_native_id_unique` UNIQUE(`provider`,`native_id`)\n);",
      "CREATE TABLE `attachments` (\n\t`pk` integer PRIMARY KEY,\n\t`message_pk` integer NOT NULL,\n\t`position` integer NOT NULL,\n\t`kind` text NOT NULL,\n\t`mime` text,\n\t`name` text,\n\t`title` text,\n\t`url` text,\n\t`size` integer,\n\t`width` integer,\n\t`height` integer,\n\t`duration` real,\n\t`provider_ref` text,\n\t`local_path` text,\n\tCONSTRAINT `fk_attachments_message_pk_messages_pk_fk` FOREIGN KEY (`message_pk`) REFERENCES `messages`(`pk`),\n\tCONSTRAINT `attachments_message_pk_position_unique` UNIQUE(`message_pk`,`position`)\n);",
      "CREATE TABLE `chats` (\n\t`pk` integer PRIMARY KEY,\n\t`account_pk` integer NOT NULL,\n\t`native_id` text NOT NULL,\n\t`kind` text NOT NULL,\n\t`title` text,\n\t`unread_count` integer,\n\t`last_message_at` integer,\n\t`participants_count` integer,\n\t`provider_metadata` text,\n\t`updated_at` integer NOT NULL,\n\tCONSTRAINT `fk_chats_account_pk_accounts_pk_fk` FOREIGN KEY (`account_pk`) REFERENCES `accounts`(`pk`),\n\tCONSTRAINT `chats_account_pk_native_id_unique` UNIQUE(`account_pk`,`native_id`)\n);",
      "CREATE TABLE `identities` (\n\t`pk` integer PRIMARY KEY,\n\t`provider` text NOT NULL,\n\t`native_id` text NOT NULL,\n\t`username` text,\n\t`name` text,\n\t`is_bot` integer,\n\t`phone_hmac` text,\n\t`provider_metadata` text,\n\t`first_seen_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tCONSTRAINT `identities_provider_native_id_unique` UNIQUE(`provider`,`native_id`)\n);",
      "CREATE TABLE `identity_link_events` (\n\t`pk` integer PRIMARY KEY,\n\t`identity_pk` integer NOT NULL,\n\t`from_person_pk` integer,\n\t`to_person_pk` integer NOT NULL,\n\t`method` text NOT NULL,\n\t`at` integer NOT NULL,\n\t`by` text NOT NULL,\n\tCONSTRAINT `fk_identity_link_events_identity_pk_identities_pk_fk` FOREIGN KEY (`identity_pk`) REFERENCES `identities`(`pk`),\n\tCONSTRAINT `fk_identity_link_events_from_person_pk_persons_pk_fk` FOREIGN KEY (`from_person_pk`) REFERENCES `persons`(`pk`),\n\tCONSTRAINT `fk_identity_link_events_to_person_pk_persons_pk_fk` FOREIGN KEY (`to_person_pk`) REFERENCES `persons`(`pk`)\n);",
      "CREATE TABLE `identity_links` (\n\t`identity_pk` integer PRIMARY KEY,\n\t`person_pk` integer NOT NULL,\n\t`method` text NOT NULL,\n\t`confidence` real NOT NULL,\n\t`linked_at` integer NOT NULL,\n\t`linked_by` text NOT NULL,\n\tCONSTRAINT `fk_identity_links_identity_pk_identities_pk_fk` FOREIGN KEY (`identity_pk`) REFERENCES `identities`(`pk`),\n\tCONSTRAINT `fk_identity_links_person_pk_persons_pk_fk` FOREIGN KEY (`person_pk`) REFERENCES `persons`(`pk`)\n);",
      "CREATE TABLE `message_revisions` (\n\t`message_pk` integer NOT NULL,\n\t`text` text NOT NULL,\n\t`edited_at` integer,\n\t`captured_at` integer NOT NULL,\n\tCONSTRAINT `fk_message_revisions_message_pk_messages_pk_fk` FOREIGN KEY (`message_pk`) REFERENCES `messages`(`pk`)\n);",
      "CREATE TABLE `messages` (\n\t`pk` integer PRIMARY KEY,\n\t`chat_pk` integer NOT NULL,\n\t`account_pk` integer NOT NULL,\n\t`native_id` text NOT NULL,\n\t`thread_native_id` text,\n\t`sender_identity_pk` integer,\n\t`sender_chat_native_id` text,\n\t`sender_name` text,\n\t`sent_at` integer NOT NULL,\n\t`edited_at` integer,\n\t`deleted_at` integer,\n\t`text` text NOT NULL,\n\t`reply_to_native_id` text,\n\t`reply_to` text,\n\t`forward` text,\n\t`outgoing` integer,\n\t`reactions` text,\n\t`provider_metadata` text,\n\t`ingested_at` integer NOT NULL,\n\t`ingested_via` text NOT NULL,\n\tCONSTRAINT `fk_messages_chat_pk_chats_pk_fk` FOREIGN KEY (`chat_pk`) REFERENCES `chats`(`pk`),\n\tCONSTRAINT `fk_messages_account_pk_accounts_pk_fk` FOREIGN KEY (`account_pk`) REFERENCES `accounts`(`pk`),\n\tCONSTRAINT `fk_messages_sender_identity_pk_identities_pk_fk` FOREIGN KEY (`sender_identity_pk`) REFERENCES `identities`(`pk`),\n\tCONSTRAINT `messages_chat_pk_native_id_unique` UNIQUE(`chat_pk`,`native_id`)\n);",
      "CREATE TABLE `persons` (\n\t`pk` integer PRIMARY KEY,\n\t`uid` text NOT NULL UNIQUE,\n\t`name` text,\n\t`is_self` integer DEFAULT 0 NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL\n);",
      "CREATE TABLE `sync_ranges` (\n\t`chat_pk` integer NOT NULL,\n\t`from_key` integer NOT NULL,\n\t`to_key` integer NOT NULL,\n\tCONSTRAINT `sync_ranges_pk` PRIMARY KEY(`chat_pk`, `from_key`),\n\tCONSTRAINT `fk_sync_ranges_chat_pk_chats_pk_fk` FOREIGN KEY (`chat_pk`) REFERENCES `chats`(`pk`)\n);",
      "CREATE INDEX `chats_by_recency` ON `chats` (`account_pk`,\"last_message_at\" desc);",
      "CREATE INDEX `identity_links_by_person` ON `identity_links` (`person_pk`);",
      "CREATE INDEX `revisions_by_message` ON `message_revisions` (`message_pk`);",
      "CREATE INDEX `messages_by_time` ON `messages` (`chat_pk`,\"sent_at\" desc);",
      "CREATE INDEX `messages_by_account` ON `messages` (`account_pk`,`native_id`);",
      "CREATE INDEX `messages_by_sender` ON `messages` (`sender_identity_pk`);"
    ]
  },
  {
    "name": "20260930003739_version-6-columns",
    "statements": [
      "ALTER TABLE `chats` ADD `username` text;",
      "ALTER TABLE `chats` ADD `membership_state` text;",
      "ALTER TABLE `chats` ADD `is_searchable` integer DEFAULT 1 NOT NULL;",
      "ALTER TABLE `chats` ADD `message_count` integer DEFAULT 0 NOT NULL;",
      "ALTER TABLE `messages` ADD `normalized_text` text;",
      "ALTER TABLE `messages` ADD `normalizer_version` integer;",
      "CREATE INDEX `messages_to_normalize` ON `messages` (`pk`) WHERE normalized_text IS NULL AND deleted_at IS NULL;"
    ]
  },
  {
    "name": "20260930003740_version-6-message-count",
    "statements": [
      "-- A chat's live messages, kept by triggers: a tombstone is not counted, and taking it back is.\nCREATE TRIGGER chats_count_ai AFTER INSERT ON messages WHEN new.deleted_at IS NULL BEGIN\n  UPDATE chats SET message_count = message_count + 1 WHERE pk = new.chat_pk;\nEND;",
      "CREATE TRIGGER chats_count_ad AFTER DELETE ON messages WHEN old.deleted_at IS NULL BEGIN\n  UPDATE chats SET message_count = message_count - 1 WHERE pk = old.chat_pk;\nEND;",
      "CREATE TRIGGER chats_count_tombstone AFTER UPDATE OF deleted_at ON messages\n  WHEN old.deleted_at IS NULL AND new.deleted_at IS NOT NULL BEGIN\n  UPDATE chats SET message_count = message_count - 1 WHERE pk = new.chat_pk;\nEND;",
      "CREATE TRIGGER chats_count_untombstone AFTER UPDATE OF deleted_at ON messages\n  WHEN old.deleted_at IS NOT NULL AND new.deleted_at IS NULL BEGIN\n  UPDATE chats SET message_count = message_count + 1 WHERE pk = new.chat_pk;\nEND;",
      "UPDATE chats SET message_count = counted.n\n  FROM (SELECT chat_pk, count(*) AS n FROM messages WHERE deleted_at IS NULL GROUP BY chat_pk) AS counted\n  WHERE chats.pk = counted.chat_pk;"
    ]
  },
  {
    "name": "20260930022658_version-7-chat-members",
    "statements": [
      "CREATE TABLE `chat_members` (\n\t`chat_pk` integer NOT NULL,\n\t`identity_pk` integer NOT NULL,\n\tCONSTRAINT `chat_members_pk` PRIMARY KEY(`chat_pk`, `identity_pk`),\n\tCONSTRAINT `fk_chat_members_chat_pk_chats_pk_fk` FOREIGN KEY (`chat_pk`) REFERENCES `chats`(`pk`),\n\tCONSTRAINT `fk_chat_members_identity_pk_identities_pk_fk` FOREIGN KEY (`identity_pk`) REFERENCES `identities`(`pk`)\n);",
      "CREATE INDEX `chat_members_by_identity` ON `chat_members` (`identity_pk`);"
    ]
  },
  {
    "name": "20260930023839_version-8-sync-state",
    "statements": [
      "CREATE TABLE `sync_state` (\n\t`account_pk` integer NOT NULL,\n\t`key` text NOT NULL,\n\t`value` text NOT NULL,\n\t`at` integer NOT NULL,\n\tCONSTRAINT `sync_state_pk` PRIMARY KEY(`account_pk`, `key`),\n\tCONSTRAINT `fk_sync_state_account_pk_accounts_pk_fk` FOREIGN KEY (`account_pk`) REFERENCES `accounts`(`pk`)\n);"
    ]
  },
  {
    "name": "20260930024055_version-9-fetch-leases",
    "statements": [
      "CREATE TABLE `fetch_leases` (\n\t`chat_pk` integer NOT NULL,\n\t`anchor` text NOT NULL,\n\t`holder` text NOT NULL,\n\t`expires_at` integer NOT NULL,\n\tCONSTRAINT `fetch_leases_pk` PRIMARY KEY(`chat_pk`, `anchor`),\n\tCONSTRAINT `fk_fetch_leases_chat_pk_chats_pk_fk` FOREIGN KEY (`chat_pk`) REFERENCES `chats`(`pk`)\n);"
    ]
  },
  {
    "name": "20260930024643_version-10-contacts",
    "statements": [
      "ALTER TABLE `account_identities` ADD `last_messaged_at` integer;",
      "ALTER TABLE `identities` ADD `description` text;"
    ]
  },
  {
    "name": "20260930024933_version-11-transcripts",
    "statements": [
      "CREATE TABLE `transcripts` (\n\t`chat_pk` integer NOT NULL,\n\t`message_native_id` text NOT NULL,\n\t`text` text NOT NULL,\n\t`source` text NOT NULL,\n\t`heard_at` integer NOT NULL,\n\tCONSTRAINT `transcripts_pk` PRIMARY KEY(`chat_pk`, `message_native_id`),\n\tCONSTRAINT `fk_transcripts_chat_pk_chats_pk_fk` FOREIGN KEY (`chat_pk`) REFERENCES `chats`(`pk`)\n);"
    ]
  },
  {
    "name": "20261001110735_version-12-search-state",
    "statements": [
      "CREATE TABLE `search_index_state` (\n\t`name` text PRIMARY KEY,\n\t`watermark` integer NOT NULL,\n\t`filled_through` integer NOT NULL,\n\t`terms_through` integer NOT NULL,\n\t`normalizer_version` integer NOT NULL,\n\t`built_at` integer\n);"
    ]
  },
  {
    "name": "20261001110736_version-12-word-index",
    "statements": [
      "-- Words of the normalized text, ranked by bm25. Contentless with delete support: an index filled in\n-- batches after its triggers exist stays consistent only this way (phase 2 plan, S1). `scope` holds\n-- `c<chat_pk>` and `s<sender_identity_pk>` so a small chat or a sender is filtered inside the index.\nCREATE VIRTUAL TABLE message_words USING fts5(\n  normalized_text, scope,\n  content = '', contentless_delete = 1,\n  tokenize = 'unicode61 remove_diacritics 2', prefix = '3');",
      "-- 'col', not 'row': the scope tokens must never come back as a word or a correction.\nCREATE VIRTUAL TABLE message_words_vocab USING fts5vocab(message_words, 'col');",
      "CREATE TRIGGER message_words_ai AFTER INSERT ON messages WHEN new.normalized_text <> '' BEGIN\n  INSERT INTO message_words (rowid, normalized_text, scope)\n    VALUES (new.pk, new.normalized_text, 'c' || new.chat_pk || coalesce(' s' || new.sender_identity_pk, ''));\nEND;",
      "-- Every re-save of a message sets these columns; only a real change may touch the index.\nCREATE TRIGGER message_words_au AFTER UPDATE OF normalized_text, sender_identity_pk, chat_pk ON messages\n  WHEN old.normalized_text IS NOT new.normalized_text\n    OR old.sender_identity_pk IS NOT new.sender_identity_pk\n    OR old.chat_pk IS NOT new.chat_pk BEGIN\n  DELETE FROM message_words WHERE rowid = old.pk;\n  INSERT INTO message_words (rowid, normalized_text, scope)\n    SELECT new.pk, new.normalized_text, 'c' || new.chat_pk || coalesce(' s' || new.sender_identity_pk, '')\n    WHERE new.normalized_text <> '';\nEND;",
      "CREATE TRIGGER message_words_ad AFTER DELETE ON messages BEGIN\n  DELETE FROM message_words WHERE rowid = old.pk;\nEND;",
      "-- Drizzle cannot declare WITHOUT ROWID, so the vocabulary is written here and not in schema.ts.\nCREATE TABLE search_terms (\n  term   TEXT PRIMARY KEY,\n  length INTEGER NOT NULL\n) WITHOUT ROWID;",
      "CREATE TABLE search_term_trigrams (\n  trigram TEXT NOT NULL,\n  length  INTEGER NOT NULL,\n  term    TEXT NOT NULL,\n  PRIMARY KEY (trigram, length, term)\n) WITHOUT ROWID;",
      "-- 5,000 is BACKFILL_ON_OPEN and 1 is NORMALIZER_VERSION as of this version; a migration is frozen.\n-- A larger file is filled up to the watermark in batches, outside this transaction.\nINSERT INTO search_index_state (name, watermark, filled_through, terms_through, normalizer_version, built_at)\n  SELECT 'message_words', coalesce(max(pk), 0),\n    CASE WHEN count(*) <= 5000 THEN coalesce(max(pk), 0) ELSE 0 END,\n    0, 1,\n    CASE WHEN count(*) <= 5000 THEN CAST(unixepoch('subsec') * 1000 AS INTEGER) END\n  FROM messages;",
      "INSERT INTO message_words (rowid, normalized_text, scope)\n  SELECT pk, normalized_text, 'c' || chat_pk || coalesce(' s' || sender_identity_pk, '')\n  FROM messages\n  WHERE normalized_text <> '' AND (SELECT count(*) FROM messages) <= 5000;"
    ]
  },
  {
    "name": "20261001170143_version-13-conversations",
    "statements": [
      "CREATE TABLE `conversation_messages` (\n\t`conversation_pk` integer NOT NULL,\n\t`message_pk` integer NOT NULL,\n\tCONSTRAINT `conversation_messages_pk` PRIMARY KEY(`conversation_pk`, `message_pk`),\n\tCONSTRAINT `fk_conversation_messages_conversation_pk_conversations_pk_fk` FOREIGN KEY (`conversation_pk`) REFERENCES `conversations`(`pk`) ON DELETE CASCADE,\n\tCONSTRAINT `fk_conversation_messages_message_pk_messages_pk_fk` FOREIGN KEY (`message_pk`) REFERENCES `messages`(`pk`) ON DELETE CASCADE\n);",
      "CREATE TABLE `conversation_state` (\n\t`chat_pk` integer PRIMARY KEY,\n\t`enabled_at` integer NOT NULL,\n\t`built_at` integer,\n\t`algorithm_version` integer,\n\t`current_build` integer,\n\tCONSTRAINT `fk_conversation_state_chat_pk_chats_pk_fk` FOREIGN KEY (`chat_pk`) REFERENCES `chats`(`pk`) ON DELETE CASCADE\n);",
      "CREATE TABLE `conversations` (\n\t`pk` integer PRIMARY KEY,\n\t`chat_pk` integer NOT NULL,\n\t`first_message_pk` integer NOT NULL,\n\t`build` integer NOT NULL,\n\t`first_at` integer NOT NULL,\n\t`last_at` integer NOT NULL,\n\t`message_count` integer NOT NULL,\n\t`built_at` integer NOT NULL,\n\t`algorithm_version` integer NOT NULL,\n\tCONSTRAINT `fk_conversations_chat_pk_chats_pk_fk` FOREIGN KEY (`chat_pk`) REFERENCES `chats`(`pk`) ON DELETE CASCADE,\n\tCONSTRAINT `fk_conversations_first_message_pk_messages_pk_fk` FOREIGN KEY (`first_message_pk`) REFERENCES `messages`(`pk`) ON DELETE CASCADE\n);",
      "CREATE TABLE `message_links` (\n\t`chat_pk` integer NOT NULL,\n\t`message_pk` integer NOT NULL,\n\t`parent_pk` integer,\n\t`source` text NOT NULL,\n\t`kind` text NOT NULL,\n\t`confidence` real NOT NULL,\n\t`method` text NOT NULL,\n\t`version` text,\n\t`batch` text,\n\t`build` integer,\n\t`created_at` integer NOT NULL,\n\t`stale_at` integer,\n\tCONSTRAINT `fk_message_links_chat_pk_chats_pk_fk` FOREIGN KEY (`chat_pk`) REFERENCES `chats`(`pk`) ON DELETE CASCADE,\n\tCONSTRAINT `fk_message_links_message_pk_messages_pk_fk` FOREIGN KEY (`message_pk`) REFERENCES `messages`(`pk`) ON DELETE CASCADE,\n\tCONSTRAINT `fk_message_links_parent_pk_messages_pk_fk` FOREIGN KEY (`parent_pk`) REFERENCES `messages`(`pk`) ON DELETE CASCADE\n);",
      "ALTER TABLE `messages` ADD `mentions` text;",
      "CREATE INDEX `conversation_messages_by_message` ON `conversation_messages` (`message_pk`);",
      "CREATE INDEX `conversations_by_chat` ON `conversations` (`chat_pk`,`build`,`first_at`);",
      "CREATE UNIQUE INDEX `message_links_unique` ON `message_links` (`message_pk`,ifnull(\"parent_pk\", 0),`source`,`kind`,ifnull(\"build\", 0));",
      "CREATE INDEX `message_links_by_parent` ON `message_links` (`parent_pk`);",
      "CREATE INDEX `message_links_by_build` ON `message_links` (`chat_pk`,`build`);"
    ]
  },
  {
    "name": "20261001231437_version-14-chunks",
    "statements": [
      "CREATE TABLE `chunk_vectors` (\n\t`model` text NOT NULL,\n\t`content_hash` text NOT NULL,\n\t`dims` integer NOT NULL,\n\t`vector` blob NOT NULL,\n\t`created_at` integer NOT NULL,\n\tCONSTRAINT `chunk_vectors_pk` PRIMARY KEY(`model`, `content_hash`)\n);",
      "CREATE TABLE `conversation_chunks` (\n\t`conversation_pk` integer NOT NULL,\n\t`ordinal` integer NOT NULL,\n\t`first_message_pk` integer NOT NULL,\n\t`last_message_pk` integer NOT NULL,\n\t`content_hash` text NOT NULL,\n\tCONSTRAINT `conversation_chunks_pk` PRIMARY KEY(`conversation_pk`, `ordinal`),\n\tCONSTRAINT `fk_conversation_chunks_conversation_pk_conversations_pk_fk` FOREIGN KEY (`conversation_pk`) REFERENCES `conversations`(`pk`) ON DELETE CASCADE,\n\tCONSTRAINT `fk_conversation_chunks_first_message_pk_messages_pk_fk` FOREIGN KEY (`first_message_pk`) REFERENCES `messages`(`pk`) ON DELETE CASCADE,\n\tCONSTRAINT `fk_conversation_chunks_last_message_pk_messages_pk_fk` FOREIGN KEY (`last_message_pk`) REFERENCES `messages`(`pk`) ON DELETE CASCADE\n);",
      "CREATE INDEX `conversation_chunks_by_hash` ON `conversation_chunks` (`content_hash`);"
    ]
  },
  {
    "name": "20261004194933_version-15-stem-state",
    "statements": [
      "CREATE TABLE `message_stems_pending` (\n\t`pk` integer PRIMARY KEY\n);",
      "CREATE TABLE `store_settings` (\n\t`key` text PRIMARY KEY,\n\t`value` text NOT NULL,\n\t`at` integer NOT NULL\n);",
      "ALTER TABLE `search_index_state` ADD `analyzer` text;"
    ]
  },
  {
    "name": "20261004194950_version-15-stem-index",
    "statements": [
      "-- Snowball stems of `messages.text`, shaped like `message_words` so its `scope` filter and bm25 weights\n-- carry over. No prefix index: wildcards never read stems. SQL cannot stem — a UDF in a trigger would\n-- break every older writer — so the triggers only queue the message, and JS writes the stems.\nCREATE VIRTUAL TABLE message_stems USING fts5(\n  stems, scope,\n  content = '', contentless_delete = 1,\n  tokenize = 'unicode61 remove_diacritics 2');",
      "CREATE TRIGGER message_stems_ai AFTER INSERT ON messages WHEN new.text <> '' BEGIN\n  INSERT OR IGNORE INTO message_stems_pending (pk) VALUES (new.pk);\nEND;",
      "CREATE TRIGGER message_stems_au AFTER UPDATE OF text, sender_identity_pk, chat_pk ON messages\n  WHEN old.text IS NOT new.text\n    OR old.sender_identity_pk IS NOT new.sender_identity_pk\n    OR old.chat_pk IS NOT new.chat_pk BEGIN\n  INSERT OR IGNORE INTO message_stems_pending (pk) VALUES (new.pk);\nEND;",
      "CREATE TRIGGER message_stems_ad AFTER DELETE ON messages BEGIN\n  DELETE FROM message_stems WHERE rowid = old.pk;\n  DELETE FROM message_stems_pending WHERE pk = old.pk;\nEND;",
      "-- 1 is NORMALIZER_VERSION as of this version; a migration is frozen. Every file starts unbuilt\n-- (analyzer NULL): the first JS fill claims the row with its analyzer and fills up to the watermark.\nINSERT INTO search_index_state (name, watermark, filled_through, terms_through, normalizer_version, analyzer)\n  SELECT 'message_stems', coalesce(max(pk), 0), 0, 0, 1, NULL FROM messages;"
    ]
  },
  {
    "name": "20261004201838_version-16-tags",
    "statements": [
      "CREATE TABLE `tags` (\n\t`pk` integer PRIMARY KEY,\n\t`taggable_type` text NOT NULL,\n\t`taggable_pk` integer NOT NULL,\n\t`tag` text NOT NULL,\n\t`created_at` integer NOT NULL,\n\tCONSTRAINT `tags_taggable_type_taggable_pk_tag_unique` UNIQUE(`taggable_type`,`taggable_pk`,`tag`)\n);",
      "CREATE INDEX `tags_by_tag` ON `tags` (`tag`,`taggable_type`,`taggable_pk`);"
    ]
  },
  {
    "name": "20261004201839_version-16-tag-triggers",
    "statements": [
      "-- A tag has no foreign key to cascade by: these keep a deleted message's or chat's tags from outliving it.\nCREATE TRIGGER tags_message_tombstone AFTER UPDATE OF deleted_at ON messages\n  WHEN old.deleted_at IS NULL AND new.deleted_at IS NOT NULL BEGIN\n  DELETE FROM tags WHERE taggable_type = 'message' AND taggable_pk = new.pk;\nEND;",
      "CREATE TRIGGER tags_message_ad AFTER DELETE ON messages BEGIN\n  DELETE FROM tags WHERE taggable_type = 'message' AND taggable_pk = old.pk;\nEND;",
      "CREATE TRIGGER tags_chat_ad AFTER DELETE ON chats BEGIN\n  DELETE FROM tags WHERE taggable_type = 'chat' AND taggable_pk = old.pk;\nEND;"
    ]
  },
  {
    "name": "20261004202018_version-17-searches",
    "statements": [
      "CREATE TABLE `searches` (\n\t`pk` integer PRIMARY KEY,\n\t`name` text UNIQUE,\n\t`command` text NOT NULL,\n\t`params` text NOT NULL,\n\t`language` text NOT NULL,\n\t`version` integer NOT NULL,\n\t`fields_version` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`last_run_at` integer,\n\t`runs` integer DEFAULT 0 NOT NULL\n);",
      "CREATE UNIQUE INDEX `searches_history` ON `searches` (`command`,`params`) WHERE name IS NULL;",
      "CREATE INDEX `searches_by_last_run` ON `searches` (\"last_run_at\" desc);"
    ]
  },
  {
    "name": "20261004215824_version-18-member-history",
    "statements": [
      "CREATE TABLE `identity_revisions` (\n\t`pk` integer PRIMARY KEY,\n\t`identity_pk` integer NOT NULL,\n\t`name` text,\n\t`username` text,\n\t`description` text,\n\t`marks` text,\n\t`captured_at` integer NOT NULL,\n\tCONSTRAINT `fk_identity_revisions_identity_pk_identities_pk_fk` FOREIGN KEY (`identity_pk`) REFERENCES `identities`(`pk`)\n);",
      "CREATE TABLE `member_counts` (\n\t`chat_pk` integer NOT NULL,\n\t`day` text NOT NULL,\n\t`participants` integer,\n\t`listed` integer NOT NULL,\n\t`complete` integer NOT NULL,\n\t`at` integer NOT NULL,\n\tCONSTRAINT `member_counts_pk` PRIMARY KEY(`chat_pk`, `day`),\n\tCONSTRAINT `fk_member_counts_chat_pk_chats_pk_fk` FOREIGN KEY (`chat_pk`) REFERENCES `chats`(`pk`)\n);",
      "CREATE TABLE `member_stays` (\n\t`pk` integer PRIMARY KEY,\n\t`chat_pk` integer NOT NULL,\n\t`identity_pk` integer NOT NULL,\n\t`first_seen_at` integer NOT NULL,\n\t`last_seen_at` integer NOT NULL,\n\t`joined_at` integer,\n\t`invited_by_pk` integer,\n\t`role` text,\n\t`gone_at` integer,\n\tCONSTRAINT `fk_member_stays_chat_pk_chats_pk_fk` FOREIGN KEY (`chat_pk`) REFERENCES `chats`(`pk`),\n\tCONSTRAINT `fk_member_stays_identity_pk_identities_pk_fk` FOREIGN KEY (`identity_pk`) REFERENCES `identities`(`pk`),\n\tCONSTRAINT `fk_member_stays_invited_by_pk_identities_pk_fk` FOREIGN KEY (`invited_by_pk`) REFERENCES `identities`(`pk`)\n);",
      "ALTER TABLE `chats` ADD `members_tracked_at` integer;",
      "CREATE INDEX `identity_revisions_by_identity` ON `identity_revisions` (`identity_pk`,`captured_at`);",
      "CREATE UNIQUE INDEX `member_stays_open` ON `member_stays` (`chat_pk`,`identity_pk`) WHERE gone_at IS NULL;",
      "CREATE INDEX `member_stays_by_identity` ON `member_stays` (`identity_pk`);"
    ]
  },
  {
    "name": "20261005142356_version-19-attachment-texts",
    "statements": [
      "CREATE TABLE `attachment_texts` (\n\t`attachment_pk` integer PRIMARY KEY,\n\t`text` text NOT NULL,\n\t`normalized_text` text NOT NULL,\n\t`origin` text NOT NULL,\n\t`extractor` text NOT NULL,\n\t`content_sha256` text,\n\t`bytes` integer,\n\t`error` text,\n\t`written_at` integer NOT NULL\n);"
    ]
  },
  {
    "name": "20261005142357_version-19-attachment-words",
    "statements": [
      "-- Words of the attachments' text, rowid = attachment pk. Kept apart from message_words so `text:` stays\n-- what was written and a file's words never rank a message (max-cli plan, file content search, D3 a).\nCREATE VIRTUAL TABLE attachment_words USING fts5(\n  normalized_text,\n  content = '', contentless_delete = 1,\n  tokenize = 'unicode61 remove_diacritics 2');",
      "CREATE TRIGGER attachment_words_ai AFTER INSERT ON attachment_texts WHEN new.normalized_text <> '' BEGIN\n  INSERT INTO attachment_words (rowid, normalized_text) VALUES (new.attachment_pk, new.normalized_text);\nEND;",
      "CREATE TRIGGER attachment_words_au AFTER UPDATE OF normalized_text ON attachment_texts\n  WHEN old.normalized_text IS NOT new.normalized_text BEGIN\n  DELETE FROM attachment_words WHERE rowid = old.attachment_pk;\n  INSERT INTO attachment_words (rowid, normalized_text)\n    SELECT new.attachment_pk, new.normalized_text WHERE new.normalized_text <> '';\nEND;",
      "CREATE TRIGGER attachment_words_ad AFTER DELETE ON attachment_texts BEGIN\n  DELETE FROM attachment_words WHERE rowid = old.attachment_pk;\nEND;",
      "-- Triggers, not code, so a build pinned to an older package still erases a deleted message's file text.\nCREATE TRIGGER attachment_texts_message_tombstone AFTER UPDATE OF deleted_at ON messages\n  WHEN old.deleted_at IS NULL AND new.deleted_at IS NOT NULL BEGIN\n  DELETE FROM attachment_texts WHERE attachment_pk IN (SELECT pk FROM attachments WHERE message_pk = new.pk);\nEND;",
      "CREATE TRIGGER attachment_texts_message_ad AFTER DELETE ON messages BEGIN\n  DELETE FROM attachment_texts WHERE attachment_pk IN (SELECT pk FROM attachments WHERE message_pk = old.pk);\nEND;",
      "CREATE TRIGGER attachment_texts_attachment_ad AFTER DELETE ON attachments BEGIN\n  DELETE FROM attachment_texts WHERE attachment_pk = old.pk;\nEND;"
    ]
  },
  {
    "name": "20261005215529_version-20-tasks",
    "statements": [
      "CREATE TABLE `tasks` (\n\t`id` text PRIMARY KEY,\n\t`source` text NOT NULL,\n\t`source_kind` text NOT NULL,\n\t`account` text NOT NULL,\n\t`group_key` text NOT NULL,\n\t`kind` text NOT NULL,\n\t`state` text NOT NULL,\n\t`reason` text,\n\t`origin` text NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`due_at` integer,\n\t`closed_at` integer,\n\t`closed_by` text\n);",
      "CREATE INDEX `tasks_by_source` ON `tasks` (`account`,`source`);",
      "CREATE INDEX `tasks_by_state` ON `tasks` (`account`,`state`,`group_key`);"
    ]
  }
]
