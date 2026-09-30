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
  }
]
