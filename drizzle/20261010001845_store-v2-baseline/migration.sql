CREATE TABLE `account_identities` (
	`account_id` integer NOT NULL,
	`identity_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`last_messaged_at` integer,
	`updated_at` integer NOT NULL,
	CONSTRAINT `account_identities_pk` PRIMARY KEY(`account_id`, `identity_id`),
	CONSTRAINT `fk_account_identities_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `fk_account_identities_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`)
);
--> statement-breakpoint
CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY,
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	`name` text,
	`created_at` integer NOT NULL,
	`settings` text,
	`status` text,
	`updated_at` integer NOT NULL,
	CONSTRAINT `accounts_provider_external_id_unique` UNIQUE(`provider`,`external_id`)
);
--> statement-breakpoint
CREATE TABLE `aliases` (
	`id` integer PRIMARY KEY,
	`aliasable_type` text NOT NULL,
	`aliasable_id` integer NOT NULL,
	`account_id` integer,
	`name` text NOT NULL,
	`name_folded` text NOT NULL,
	`display` integer DEFAULT 0 NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_aliases_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`)
);
--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` integer PRIMARY KEY,
	`attachable_type` text NOT NULL,
	`attachable_id` integer NOT NULL,
	`position` integer NOT NULL,
	`kind` text NOT NULL,
	`mime` text,
	`name` text,
	`title` text,
	`url` text,
	`size` integer,
	`width` integer,
	`height` integer,
	`duration` real,
	`provider_ref` text,
	`local_path` text,
	`text` text,
	`normalized_text` text,
	`extraction` text,
	`extractor` text,
	`extraction_error` text,
	`content_sha256` text,
	`extracted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `attachments_attachable_type_attachable_id_position_unique` UNIQUE(`attachable_type`,`attachable_id`,`position`)
);
--> statement-breakpoint
CREATE TABLE `auto_tag_claims` (
	`chat_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	`algorithm` text NOT NULL,
	`score` real NOT NULL,
	`fields` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `auto_tag_claims_pk` PRIMARY KEY(`chat_id`, `tag_id`),
	CONSTRAINT `fk_auto_tag_claims_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`),
	CONSTRAINT `fk_auto_tag_claims_tag_id_tags_id_fk` FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`)
);
--> statement-breakpoint
CREATE TABLE `bots` (
	`id` integer PRIMARY KEY,
	`name` text NOT NULL UNIQUE,
	`kind` text NOT NULL,
	`description` text,
	`owner_person_id` integer,
	`model` text,
	`token_digest` text,
	`last_seen_at` integer,
	`disabled_at` integer,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_bots_owner_person_id_persons_id_fk` FOREIGN KEY (`owner_person_id`) REFERENCES `persons`(`id`)
);
--> statement-breakpoint
CREATE TABLE `chat_members` (
	`chat_id` integer NOT NULL,
	`identity_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `chat_members_pk` PRIMARY KEY(`chat_id`, `identity_id`),
	CONSTRAINT `fk_chat_members_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`),
	CONSTRAINT `fk_chat_members_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`)
);
--> statement-breakpoint
CREATE TABLE `chats` (
	`id` integer PRIMARY KEY,
	`account_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text,
	`unread_count` integer,
	`last_message_at` integer,
	`participants_count` integer,
	`metadata` text,
	`updated_at` integer NOT NULL,
	`username` text,
	`membership_state` text,
	`searchable` integer DEFAULT 1 NOT NULL,
	`message_count` integer DEFAULT 0 NOT NULL,
	`members_tracked_at` integer,
	`description` text,
	`details_fetched_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_chats_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `chats_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`)
);
--> statement-breakpoint
CREATE TABLE `chunks` (
	`id` integer PRIMARY KEY,
	`chunkable_type` text NOT NULL,
	`chunkable_id` integer NOT NULL,
	`position` integer NOT NULL,
	`start_offset` integer NOT NULL,
	`end_offset` integer NOT NULL,
	`content_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `chunks_chunkable_type_chunkable_id_position_unique` UNIQUE(`chunkable_type`,`chunkable_id`,`position`)
);
--> statement-breakpoint
CREATE TABLE `conversation_chunks` (
	`conversation_id` integer NOT NULL,
	`ordinal` integer NOT NULL,
	`first_message_id` integer NOT NULL,
	`last_message_id` integer NOT NULL,
	`content_hash` text NOT NULL,
	`text_start` integer,
	`text_end` integer,
	CONSTRAINT `conversation_chunks_pk` PRIMARY KEY(`conversation_id`, `ordinal`),
	CONSTRAINT `fk_conversation_chunks_conversation_id_conversations_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_conversation_chunks_first_message_id_messages_id_fk` FOREIGN KEY (`first_message_id`) REFERENCES `messages`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_conversation_chunks_last_message_id_messages_id_fk` FOREIGN KEY (`last_message_id`) REFERENCES `messages`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `conversation_messages` (
	`conversation_id` integer NOT NULL,
	`message_id` integer NOT NULL,
	CONSTRAINT `conversation_messages_pk` PRIMARY KEY(`conversation_id`, `message_id`),
	CONSTRAINT `fk_conversation_messages_conversation_id_conversations_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_conversation_messages_message_id_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `conversation_state` (
	`chat_id` integer PRIMARY KEY,
	`enabled_at` integer NOT NULL,
	`built_at` integer,
	`algorithm_version` integer,
	`current_build` integer,
	CONSTRAINT `fk_conversation_state_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` integer PRIMARY KEY,
	`chat_id` integer NOT NULL,
	`first_message_id` integer NOT NULL,
	`build` integer NOT NULL,
	`first_at` integer NOT NULL,
	`last_at` integer NOT NULL,
	`message_count` integer NOT NULL,
	`built_at` integer NOT NULL,
	`algorithm_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_conversations_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_conversations_first_message_id_messages_id_fk` FOREIGN KEY (`first_message_id`) REFERENCES `messages`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `document_index_pending` (
	`id` integer NOT NULL,
	`indexable_type` text NOT NULL,
	CONSTRAINT `document_index_pending_pk` PRIMARY KEY(`indexable_type`, `id`)
);
--> statement-breakpoint
CREATE TABLE `document_revisions` (
	`id` integer PRIMARY KEY,
	`document_id` integer NOT NULL,
	`body` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_document_revisions_document_id_documents_id_fk` FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`)
);
--> statement-breakpoint
CREATE TABLE `documents` (
	`id` integer PRIMARY KEY,
	`account_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text,
	`location` text,
	`file_name` text,
	`extension` text,
	`url` text,
	`storage` text,
	`local_path` text,
	`mime` text,
	`size` integer,
	`content_hash` text,
	`front_matter` text,
	`body` text,
	`normalized_text` text,
	`extraction` text,
	`extraction_error` text,
	`language` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`export_path` text,
	`external_created_at` integer,
	`external_updated_at` integer,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT `fk_documents_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `documents_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`)
);
--> statement-breakpoint
CREATE TABLE `email_index_pending` (
	`id` integer NOT NULL,
	`indexable_type` text NOT NULL,
	CONSTRAINT `email_index_pending_pk` PRIMARY KEY(`indexable_type`, `id`)
);
--> statement-breakpoint
CREATE TABLE `email_mailboxes` (
	`email_id` integer NOT NULL,
	`mailbox_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `email_mailboxes_pk` PRIMARY KEY(`email_id`, `mailbox_id`),
	CONSTRAINT `fk_email_mailboxes_email_id_emails_id_fk` FOREIGN KEY (`email_id`) REFERENCES `emails`(`id`),
	CONSTRAINT `fk_email_mailboxes_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`)
);
--> statement-breakpoint
CREATE TABLE `email_recipients` (
	`id` integer PRIMARY KEY,
	`email_id` integer NOT NULL,
	`identity_id` integer,
	`address` text NOT NULL,
	`name` text,
	`role` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_email_recipients_email_id_emails_id_fk` FOREIGN KEY (`email_id`) REFERENCES `emails`(`id`),
	CONSTRAINT `fk_email_recipients_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`)
);
--> statement-breakpoint
CREATE TABLE `email_threads` (
	`id` integer PRIMARY KEY,
	`account_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`subject` text,
	`last_email_at` integer,
	`emails_count` integer DEFAULT 0 NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT `fk_email_threads_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `email_threads_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`)
);
--> statement-breakpoint
CREATE TABLE `emails` (
	`id` integer PRIMARY KEY,
	`account_id` integer NOT NULL,
	`email_thread_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`subject` text,
	`from_identity_id` integer,
	`from_address` text,
	`from_name` text,
	`sent_at` integer,
	`received_at` integer,
	`in_reply_to` text,
	`references` text,
	`body_text` text,
	`body_html` text,
	`snippet` text,
	`outgoing` integer,
	`read` integer,
	`flagged` integer,
	`draft` integer,
	`size` integer,
	`headers` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT `fk_emails_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `fk_emails_email_thread_id_email_threads_id_fk` FOREIGN KEY (`email_thread_id`) REFERENCES `email_threads`(`id`),
	CONSTRAINT `fk_emails_from_identity_id_identities_id_fk` FOREIGN KEY (`from_identity_id`) REFERENCES `identities`(`id`),
	CONSTRAINT `emails_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`)
);
--> statement-breakpoint
CREATE TABLE `embeddings` (
	`model` text NOT NULL,
	`content_hash` text NOT NULL,
	`dims` integer NOT NULL,
	`vector` blob NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `embeddings_pk` PRIMARY KEY(`model`, `content_hash`)
);
--> statement-breakpoint
CREATE TABLE `entities` (
	`id` integer PRIMARY KEY,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `event_series` (
	`id` integer PRIMARY KEY,
	`title` text,
	`recurrence` text,
	`origin` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY,
	`event_series_id` integer,
	`title` text,
	`description` text,
	`location` text,
	`starts_at` integer,
	`ends_at` integer,
	`timezone` text,
	`origin` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT `fk_events_event_series_id_event_series_id_fk` FOREIGN KEY (`event_series_id`) REFERENCES `event_series`(`id`)
);
--> statement-breakpoint
CREATE TABLE `fetch_leases` (
	`chat_id` integer NOT NULL,
	`anchor` text NOT NULL,
	`holder` text NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT `fetch_leases_pk` PRIMARY KEY(`chat_id`, `anchor`),
	CONSTRAINT `fk_fetch_leases_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`)
);
--> statement-breakpoint
CREATE TABLE `identities` (
	`id` integer PRIMARY KEY,
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	`username` text,
	`name` text,
	`bot` integer,
	`phone_hmac` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`description` text,
	CONSTRAINT `identities_provider_external_id_unique` UNIQUE(`provider`,`external_id`)
);
--> statement-breakpoint
CREATE TABLE `identity_link_events` (
	`id` integer PRIMARY KEY,
	`identity_id` integer NOT NULL,
	`from_person_id` integer,
	`to_person_id` integer NOT NULL,
	`method` text NOT NULL,
	`created_at` integer NOT NULL,
	`author` text NOT NULL,
	CONSTRAINT `fk_identity_link_events_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`),
	CONSTRAINT `fk_identity_link_events_from_person_id_persons_id_fk` FOREIGN KEY (`from_person_id`) REFERENCES `persons`(`id`),
	CONSTRAINT `fk_identity_link_events_to_person_id_persons_id_fk` FOREIGN KEY (`to_person_id`) REFERENCES `persons`(`id`)
);
--> statement-breakpoint
CREATE TABLE `identity_links` (
	`identity_id` integer PRIMARY KEY,
	`person_id` integer NOT NULL,
	`method` text NOT NULL,
	`confidence` real NOT NULL,
	`created_at` integer NOT NULL,
	`author` text NOT NULL,
	`source` text,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_identity_links_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`),
	CONSTRAINT `fk_identity_links_person_id_persons_id_fk` FOREIGN KEY (`person_id`) REFERENCES `persons`(`id`)
);
--> statement-breakpoint
CREATE TABLE `identity_revisions` (
	`id` integer PRIMARY KEY,
	`identity_id` integer NOT NULL,
	`name` text,
	`username` text,
	`description` text,
	`marks` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_identity_revisions_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`)
);
--> statement-breakpoint
CREATE TABLE `links` (
	`id` integer PRIMARY KEY,
	`from_type` text NOT NULL,
	`from_id` integer NOT NULL,
	`to_type` text,
	`to_id` integer,
	`kind` text NOT NULL,
	`anchor` text,
	`source` text NOT NULL,
	`target_text` text,
	`target_folded` text,
	`role` text,
	`evidence` text,
	`metadata` text,
	`confirmed` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`author` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mailboxes` (
	`id` integer PRIMARY KEY,
	`account_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_mailboxes_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `mailboxes_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`)
);
--> statement-breakpoint
CREATE TABLE `meeting_chat_messages` (
	`id` integer PRIMARY KEY,
	`meeting_id` integer NOT NULL,
	`external_id` text,
	`sent_at` integer NOT NULL,
	`sender_participant_id` integer,
	`sender_name` text,
	`recipient` text,
	`text` text NOT NULL,
	`normalized_text` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_meeting_chat_messages_meeting_id_meetings_id_fk` FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`),
	CONSTRAINT `fk_meeting_chat_messages_sender_participant_id_meeting_participants_id_fk` FOREIGN KEY (`sender_participant_id`) REFERENCES `meeting_participants`(`id`)
);
--> statement-breakpoint
CREATE TABLE `meeting_index_pending` (
	`id` integer NOT NULL,
	`indexable_type` text NOT NULL,
	CONSTRAINT `meeting_index_pending_pk` PRIMARY KEY(`indexable_type`, `id`)
);
--> statement-breakpoint
CREATE TABLE `meeting_participants` (
	`id` integer PRIMARY KEY,
	`meeting_id` integer NOT NULL,
	`identity_id` integer NOT NULL,
	`display_name` text,
	`email` text,
	`role` text,
	`joined_at` integer,
	`left_at` integer,
	`duration_ms` integer,
	`sessions` text,
	`external_id` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_meeting_participants_meeting_id_meetings_id_fk` FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`),
	CONSTRAINT `fk_meeting_participants_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`),
	CONSTRAINT `meeting_participants_meeting_id_identity_id_unique` UNIQUE(`meeting_id`,`identity_id`)
);
--> statement-breakpoint
CREATE TABLE `meeting_series` (
	`id` integer PRIMARY KEY,
	`account_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`event_series_id` integer,
	`title` text,
	`description` text,
	`kind` text,
	`recurrence` text,
	`host_identity_id` integer,
	`join_url` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT `fk_meeting_series_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `fk_meeting_series_event_series_id_event_series_id_fk` FOREIGN KEY (`event_series_id`) REFERENCES `event_series`(`id`),
	CONSTRAINT `fk_meeting_series_host_identity_id_identities_id_fk` FOREIGN KEY (`host_identity_id`) REFERENCES `identities`(`id`),
	CONSTRAINT `meeting_series_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`)
);
--> statement-breakpoint
CREATE TABLE `meeting_summaries` (
	`id` integer PRIMARY KEY,
	`meeting_id` integer NOT NULL,
	`source` text NOT NULL,
	`title` text,
	`overview` text,
	`sections` text,
	`next_steps` text,
	`content` text,
	`doc_url` text,
	`external_created_at` integer,
	`external_updated_at` integer,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_meeting_summaries_meeting_id_meetings_id_fk` FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`)
);
--> statement-breakpoint
CREATE TABLE `meeting_transcript_rows` (
	`id` integer PRIMARY KEY,
	`meeting_transcript_id` integer NOT NULL,
	`position` integer NOT NULL,
	`start_ms` integer NOT NULL,
	`end_ms` integer NOT NULL,
	`speaker_participant_id` integer,
	`speaker_name` text,
	`text` text NOT NULL,
	`normalized_text` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_meeting_transcript_rows_meeting_transcript_id_meeting_transcripts_id_fk` FOREIGN KEY (`meeting_transcript_id`) REFERENCES `meeting_transcripts`(`id`),
	CONSTRAINT `fk_meeting_transcript_rows_speaker_participant_id_meeting_participants_id_fk` FOREIGN KEY (`speaker_participant_id`) REFERENCES `meeting_participants`(`id`),
	CONSTRAINT `meeting_transcript_rows_meeting_transcript_id_position_unique` UNIQUE(`meeting_transcript_id`,`position`)
);
--> statement-breakpoint
CREATE TABLE `meeting_transcripts` (
	`id` integer PRIMARY KEY,
	`meeting_id` integer NOT NULL,
	`source` text NOT NULL,
	`format` text,
	`language` text,
	`content_hash` text,
	`external_created_at` integer,
	`superseded_at` integer,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT `fk_meeting_transcripts_meeting_id_meetings_id_fk` FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`)
);
--> statement-breakpoint
CREATE TABLE `meetings` (
	`id` integer PRIMARY KEY,
	`account_id` integer NOT NULL,
	`meeting_series_id` integer,
	`event_id` integer,
	`external_id` text NOT NULL,
	`title` text,
	`description` text,
	`location` text,
	`join_url` text,
	`started_at` integer,
	`ended_at` integer,
	`duration_ms` integer,
	`timezone` text,
	`host_identity_id` integer,
	`participants_count` integer,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT `fk_meetings_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `fk_meetings_meeting_series_id_meeting_series_id_fk` FOREIGN KEY (`meeting_series_id`) REFERENCES `meeting_series`(`id`),
	CONSTRAINT `fk_meetings_event_id_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`),
	CONSTRAINT `fk_meetings_host_identity_id_identities_id_fk` FOREIGN KEY (`host_identity_id`) REFERENCES `identities`(`id`),
	CONSTRAINT `meetings_account_id_external_id_unique` UNIQUE(`account_id`,`external_id`)
);
--> statement-breakpoint
CREATE TABLE `member_counts` (
	`chat_id` integer NOT NULL,
	`date` text NOT NULL,
	`reported_count` integer,
	`listed_count` integer NOT NULL,
	`complete_list` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `member_counts_pk` PRIMARY KEY(`chat_id`, `date`),
	CONSTRAINT `fk_member_counts_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`)
);
--> statement-breakpoint
CREATE TABLE `member_stays` (
	`id` integer PRIMARY KEY,
	`chat_id` integer NOT NULL,
	`identity_id` integer NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`joined_at` integer,
	`invited_by_identity_id` integer,
	`role` text,
	`left_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_member_stays_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`),
	CONSTRAINT `fk_member_stays_identity_id_identities_id_fk` FOREIGN KEY (`identity_id`) REFERENCES `identities`(`id`),
	CONSTRAINT `fk_member_stays_invited_by_identity_id_identities_id_fk` FOREIGN KEY (`invited_by_identity_id`) REFERENCES `identities`(`id`)
);
--> statement-breakpoint
CREATE TABLE `message_counter_observations` (
	`message_id` integer NOT NULL,
	`counter` text NOT NULL,
	`value` real NOT NULL,
	`created_at` integer NOT NULL,
	`source` text NOT NULL,
	CONSTRAINT `message_counter_observations_pk` PRIMARY KEY(`message_id`, `counter`),
	CONSTRAINT `fk_message_counter_observations_message_id_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `message_links` (
	`id` integer PRIMARY KEY,
	`chat_id` integer NOT NULL,
	`message_id` integer NOT NULL,
	`parent_id` integer,
	`source` text NOT NULL,
	`kind` text NOT NULL,
	`confidence` real NOT NULL,
	`method` text NOT NULL,
	`version` text,
	`batch` text,
	`build` integer,
	`created_at` integer NOT NULL,
	`stale_at` integer,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_message_links_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_message_links_message_id_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_message_links_parent_id_messages_id_fk` FOREIGN KEY (`parent_id`) REFERENCES `messages`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `message_revisions` (
	`id` integer PRIMARY KEY,
	`message_id` integer NOT NULL,
	`text` text NOT NULL,
	`edited_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_message_revisions_message_id_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`)
);
--> statement-breakpoint
CREATE TABLE `message_stems_pending` (
	`id` integer PRIMARY KEY
);
--> statement-breakpoint
CREATE TABLE `message_transcripts` (
	`id` integer PRIMARY KEY,
	`message_id` integer,
	`chat_id` integer NOT NULL,
	`message_external_id` text NOT NULL,
	`text` text NOT NULL,
	`source` text NOT NULL,
	`heard_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_message_transcripts_message_id_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`),
	CONSTRAINT `fk_message_transcripts_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`),
	CONSTRAINT `message_transcripts_chat_id_message_external_id_unique` UNIQUE(`chat_id`,`message_external_id`)
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY,
	`chat_id` integer NOT NULL,
	`account_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`thread_external_id` text,
	`sender_identity_id` integer,
	`sender_chat_external_id` text,
	`sender_name` text,
	`sent_at` integer NOT NULL,
	`edited_at` integer,
	`deleted_at` integer,
	`text` text NOT NULL,
	`reply_to_external_id` text,
	`reply_to` text,
	`forward` text,
	`outgoing` integer,
	`reactions` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`source` text NOT NULL,
	`normalized_text` text,
	`normalizer_version` integer,
	`mentions` text,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_messages_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`),
	CONSTRAINT `fk_messages_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
	CONSTRAINT `fk_messages_sender_identity_id_identities_id_fk` FOREIGN KEY (`sender_identity_id`) REFERENCES `identities`(`id`),
	CONSTRAINT `messages_chat_id_external_id_unique` UNIQUE(`chat_id`,`external_id`)
);
--> statement-breakpoint
CREATE TABLE `note_index_pending` (
	`id` integer NOT NULL,
	`indexable_type` text NOT NULL,
	CONSTRAINT `note_index_pending_pk` PRIMARY KEY(`indexable_type`, `id`)
);
--> statement-breakpoint
CREATE TABLE `note_revisions` (
	`id` integer PRIMARY KEY,
	`note_id` integer NOT NULL,
	`body` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_note_revisions_note_id_notes_id_fk` FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`)
);
--> statement-breakpoint
CREATE TABLE `notes` (
	`id` integer PRIMARY KEY,
	`notable_type` text NOT NULL,
	`notable_id` integer NOT NULL,
	`title` text,
	`body` text NOT NULL,
	`author_type` text,
	`author_id` integer,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE TABLE `persons` (
	`id` integer PRIMARY KEY,
	`name` text,
	`owner` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` integer PRIMARY KEY,
	`key` text NOT NULL UNIQUE,
	`name` text NOT NULL,
	`description` text,
	`owner_type` text,
	`owner_id` integer,
	`tasks_count` integer DEFAULT 0 NOT NULL,
	`status` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE TABLE `reminders` (
	`id` integer PRIMARY KEY,
	`task_id` integer NOT NULL,
	`account_id` integer NOT NULL,
	`due_at` integer NOT NULL,
	`timezone` text NOT NULL,
	`state` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`lease_until` integer,
	`receipt` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_reminders_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`),
	CONSTRAINT `fk_reminders_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`)
);
--> statement-breakpoint
CREATE TABLE `search_index_state` (
	`name` text PRIMARY KEY,
	`watermark` integer NOT NULL,
	`filled_through` integer NOT NULL,
	`terms_through` integer NOT NULL,
	`normalizer_version` integer NOT NULL,
	`built_at` integer,
	`analyzer` text
);
--> statement-breakpoint
CREATE TABLE `searches` (
	`id` integer PRIMARY KEY,
	`name` text UNIQUE,
	`command` text NOT NULL,
	`params` text NOT NULL,
	`language` text NOT NULL,
	`version` integer NOT NULL,
	`fields_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`last_run_at` integer,
	`runs` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `store_settings` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_cursors` (
	`account_id` integer NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `sync_cursors_pk` PRIMARY KEY(`account_id`, `key`),
	CONSTRAINT `fk_sync_cursors_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`)
);
--> statement-breakpoint
CREATE TABLE `sync_ranges` (
	`chat_id` integer NOT NULL,
	`from_key` integer NOT NULL,
	`to_key` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `sync_ranges_pk` PRIMARY KEY(`chat_id`, `from_key`),
	CONSTRAINT `fk_sync_ranges_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`)
);
--> statement-breakpoint
CREATE TABLE `syncs` (
	`id` integer PRIMARY KEY,
	`account_id` integer NOT NULL,
	`kind` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text NOT NULL,
	`counts` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_syncs_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`)
);
--> statement-breakpoint
CREATE TABLE `taggings` (
	`id` integer PRIMARY KEY,
	`tag_id` integer NOT NULL,
	`taggable_type` text NOT NULL,
	`taggable_id` integer NOT NULL,
	`source` text NOT NULL,
	`author_type` text,
	`author_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_taggings_tag_id_tags_id_fk` FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`),
	CONSTRAINT `taggings_tag_id_taggable_type_taggable_id_unique` UNIQUE(`tag_id`,`taggable_type`,`taggable_id`)
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY,
	`name` text NOT NULL UNIQUE,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_assignments` (
	`id` integer PRIMARY KEY,
	`task_id` integer NOT NULL,
	`assignee_type` text NOT NULL,
	`assignee_id` integer NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_task_assignments_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`),
	CONSTRAINT `task_assignments_task_id_assignee_type_assignee_id_role_unique` UNIQUE(`task_id`,`assignee_type`,`assignee_id`,`role`)
);
--> statement-breakpoint
CREATE TABLE `task_events` (
	`id` integer PRIMARY KEY,
	`task_id` integer NOT NULL,
	`actor_type` text,
	`actor_id` integer,
	`kind` text NOT NULL,
	`changes` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_task_events_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`)
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` integer PRIMARY KEY,
	`project_id` integer NOT NULL,
	`number` integer NOT NULL,
	`key` text NOT NULL UNIQUE,
	`title` text NOT NULL,
	`description` text,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`priority` integer,
	`parent_id` integer,
	`due_at` integer,
	`started_at` integer,
	`closed_at` integer,
	`closed_by_type` text,
	`closed_by_id` integer,
	`close_reason` text,
	`author_type` text NOT NULL,
	`author_id` integer NOT NULL,
	`source` text NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT `fk_tasks_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`),
	CONSTRAINT `fk_tasks_parent_id_tasks_id_fk` FOREIGN KEY (`parent_id`) REFERENCES `tasks`(`id`),
	CONSTRAINT `tasks_project_id_number_unique` UNIQUE(`project_id`,`number`)
);
--> statement-breakpoint
CREATE INDEX `account_identities_by_identity_id` ON `account_identities` (`identity_id`);--> statement-breakpoint
CREATE INDEX `aliases_by_aliasable_type_aliasable_id` ON `aliases` (`aliasable_type`,`aliasable_id`);--> statement-breakpoint
CREATE INDEX `aliases_by_account_id` ON `aliases` (`account_id`);--> statement-breakpoint
CREATE INDEX `auto_tag_claims_by_tag_id` ON `auto_tag_claims` (`tag_id`);--> statement-breakpoint
CREATE INDEX `bots_by_owner_person_id` ON `bots` (`owner_person_id`);--> statement-breakpoint
CREATE INDEX `chat_members_by_identity_id` ON `chat_members` (`identity_id`);--> statement-breakpoint
CREATE INDEX `chats_by_recency` ON `chats` (`account_id`,"last_message_at" desc);--> statement-breakpoint
CREATE INDEX `chunks_by_content_hash` ON `chunks` (`content_hash`);--> statement-breakpoint
CREATE INDEX `conversation_chunks_by_hash` ON `conversation_chunks` (`content_hash`);--> statement-breakpoint
CREATE INDEX `conversation_chunks_by_first_message_id` ON `conversation_chunks` (`first_message_id`);--> statement-breakpoint
CREATE INDEX `conversation_chunks_by_last_message_id` ON `conversation_chunks` (`last_message_id`);--> statement-breakpoint
CREATE INDEX `conversation_messages_by_message_id` ON `conversation_messages` (`message_id`);--> statement-breakpoint
CREATE INDEX `conversations_by_chat` ON `conversations` (`chat_id`,`build`,`first_at`);--> statement-breakpoint
CREATE INDEX `conversations_by_first_message_id` ON `conversations` (`first_message_id`);--> statement-breakpoint
CREATE INDEX `document_revisions_by_document_id` ON `document_revisions` (`document_id`);--> statement-breakpoint
CREATE INDEX `email_mailboxes_by_mailbox_id` ON `email_mailboxes` (`mailbox_id`);--> statement-breakpoint
CREATE INDEX `email_recipients_by_email_id` ON `email_recipients` (`email_id`);--> statement-breakpoint
CREATE INDEX `email_recipients_by_identity_id` ON `email_recipients` (`identity_id`);--> statement-breakpoint
CREATE INDEX `emails_by_time` ON `emails` (`account_id`,"sent_at" desc);--> statement-breakpoint
CREATE INDEX `emails_by_email_thread_id` ON `emails` (`email_thread_id`);--> statement-breakpoint
CREATE INDEX `emails_by_from_identity_id` ON `emails` (`from_identity_id`);--> statement-breakpoint
CREATE INDEX `events_by_time` ON `events` (`starts_at`);--> statement-breakpoint
CREATE INDEX `events_by_event_series_id` ON `events` (`event_series_id`);--> statement-breakpoint
CREATE INDEX `identity_link_events_by_identity_id` ON `identity_link_events` (`identity_id`);--> statement-breakpoint
CREATE INDEX `identity_link_events_by_from_person_id` ON `identity_link_events` (`from_person_id`);--> statement-breakpoint
CREATE INDEX `identity_link_events_by_to_person_id` ON `identity_link_events` (`to_person_id`);--> statement-breakpoint
CREATE INDEX `identity_links_by_person_id` ON `identity_links` (`person_id`);--> statement-breakpoint
CREATE INDEX `identity_revisions_by_identity` ON `identity_revisions` (`identity_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `links_unresolved` ON `links` (`target_folded`) WHERE to_id IS NULL;--> statement-breakpoint
CREATE INDEX `links_by_from_type_from_id` ON `links` (`from_type`,`from_id`);--> statement-breakpoint
CREATE INDEX `links_by_to_type_to_id` ON `links` (`to_type`,`to_id`);--> statement-breakpoint
CREATE INDEX `meeting_chat_messages_by_meeting_id` ON `meeting_chat_messages` (`meeting_id`);--> statement-breakpoint
CREATE INDEX `meeting_chat_messages_by_sender_participant_id` ON `meeting_chat_messages` (`sender_participant_id`);--> statement-breakpoint
CREATE INDEX `meeting_participants_by_identity_id` ON `meeting_participants` (`identity_id`);--> statement-breakpoint
CREATE INDEX `meeting_series_by_event_series_id` ON `meeting_series` (`event_series_id`);--> statement-breakpoint
CREATE INDEX `meeting_series_by_host_identity_id` ON `meeting_series` (`host_identity_id`);--> statement-breakpoint
CREATE INDEX `meeting_summaries_by_meeting_id` ON `meeting_summaries` (`meeting_id`);--> statement-breakpoint
CREATE INDEX `meeting_transcript_rows_by_speaker_participant_id` ON `meeting_transcript_rows` (`speaker_participant_id`);--> statement-breakpoint
CREATE INDEX `meeting_transcripts_by_meeting_id` ON `meeting_transcripts` (`meeting_id`);--> statement-breakpoint
CREATE INDEX `meetings_by_time` ON `meetings` (`account_id`,"started_at" desc);--> statement-breakpoint
CREATE INDEX `meetings_by_meeting_series_id` ON `meetings` (`meeting_series_id`);--> statement-breakpoint
CREATE INDEX `meetings_by_event_id` ON `meetings` (`event_id`);--> statement-breakpoint
CREATE INDEX `meetings_by_host_identity_id` ON `meetings` (`host_identity_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `member_stays_open` ON `member_stays` (`chat_id`,`identity_id`) WHERE left_at IS NULL;--> statement-breakpoint
CREATE INDEX `member_stays_by_identity_id` ON `member_stays` (`identity_id`);--> statement-breakpoint
CREATE INDEX `member_stays_by_invited_by_identity_id` ON `member_stays` (`invited_by_identity_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `message_links_unique` ON `message_links` (`message_id`,ifnull("parent_id", 0),`source`,`kind`,ifnull("build", 0));--> statement-breakpoint
CREATE INDEX `message_links_by_build` ON `message_links` (`chat_id`,`build`);--> statement-breakpoint
CREATE INDEX `message_links_by_parent_id` ON `message_links` (`parent_id`);--> statement-breakpoint
CREATE INDEX `message_revisions_by_message_id` ON `message_revisions` (`message_id`);--> statement-breakpoint
CREATE INDEX `message_transcripts_by_message_id` ON `message_transcripts` (`message_id`);--> statement-breakpoint
CREATE INDEX `messages_by_time` ON `messages` (`chat_id`,"sent_at" desc);--> statement-breakpoint
CREATE INDEX `messages_by_account` ON `messages` (`account_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `messages_to_normalize` ON `messages` (`id`) WHERE normalized_text IS NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `messages_by_sender_identity_id` ON `messages` (`sender_identity_id`);--> statement-breakpoint
CREATE INDEX `note_revisions_by_note_id` ON `note_revisions` (`note_id`);--> statement-breakpoint
CREATE INDEX `notes_by_notable_type_notable_id` ON `notes` (`notable_type`,`notable_id`);--> statement-breakpoint
CREATE INDEX `notes_by_author_type_author_id` ON `notes` (`author_type`,`author_id`);--> statement-breakpoint
CREATE INDEX `projects_by_owner_type_owner_id` ON `projects` (`owner_type`,`owner_id`);--> statement-breakpoint
CREATE INDEX `reminders_due` ON `reminders` (`account_id`,`state`,`due_at`);--> statement-breakpoint
CREATE INDEX `reminders_by_task_id` ON `reminders` (`task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `searches_history` ON `searches` (`command`,`params`) WHERE name IS NULL;--> statement-breakpoint
CREATE INDEX `searches_by_last_run` ON `searches` ("last_run_at" desc);--> statement-breakpoint
CREATE INDEX `syncs_by_account_id` ON `syncs` (`account_id`);--> statement-breakpoint
CREATE INDEX `taggings_by_taggable_type_taggable_id` ON `taggings` (`taggable_type`,`taggable_id`);--> statement-breakpoint
CREATE INDEX `taggings_by_author_type_author_id` ON `taggings` (`author_type`,`author_id`);--> statement-breakpoint
CREATE INDEX `task_assignments_by_assignee_type_assignee_id` ON `task_assignments` (`assignee_type`,`assignee_id`);--> statement-breakpoint
CREATE INDEX `task_events_by_task_id` ON `task_events` (`task_id`);--> statement-breakpoint
CREATE INDEX `task_events_by_actor_type_actor_id` ON `task_events` (`actor_type`,`actor_id`);--> statement-breakpoint
CREATE INDEX `tasks_by_status` ON `tasks` (`project_id`,`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `tasks_by_parent_id` ON `tasks` (`parent_id`);--> statement-breakpoint
CREATE INDEX `tasks_by_closed_by_type_closed_by_id` ON `tasks` (`closed_by_type`,`closed_by_id`);--> statement-breakpoint
CREATE INDEX `tasks_by_author_type_author_id` ON `tasks` (`author_type`,`author_id`);