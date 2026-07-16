CREATE TABLE `blob` (
	`sha256` text PRIMARY KEY NOT NULL,
	`size_bytes` integer NOT NULL,
	`content_type` text,
	`storage_key` text NOT NULL,
	`ref_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `crawl_event` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`resource_id` text,
	`url` text,
	`kind` text NOT NULL,
	`http_status` integer,
	`message` text,
	`at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `crawl_event_run_idx` ON `crawl_event` (`run_id`);--> statement-breakpoint
CREATE INDEX `crawl_event_kind_idx` ON `crawl_event` (`kind`);--> statement-breakpoint
CREATE TABLE `link` (
	`id` text PRIMARY KEY NOT NULL,
	`from_resource_id` text NOT NULL,
	`to_resource_id` text,
	`to_url` text NOT NULL,
	`rel` text DEFAULT 'href' NOT NULL,
	`first_run_id` text,
	`last_run_id` text,
	`last_seen_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`from_resource_id`) REFERENCES `resource`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_resource_id`) REFERENCES `resource`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `link_from_to_unique` ON `link` (`from_resource_id`,`to_url`);--> statement-breakpoint
CREATE INDEX `link_to_idx` ON `link` (`to_resource_id`);--> statement-breakpoint
CREATE TABLE `resource` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`url_hash` text NOT NULL,
	`host` text NOT NULL,
	`path` text NOT NULL,
	`kind` text DEFAULT 'page' NOT NULL,
	`content_type` text,
	`title` text,
	`http_status` integer,
	`state` text DEFAULT 'active' NOT NULL,
	`sha256` text,
	`etag` text,
	`last_modified` text,
	`size_bytes` integer,
	`latest_version_id` text,
	`first_seen_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`last_seen_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`last_fetched_at` integer,
	`last_changed_at` integer,
	`first_run_id` text,
	`last_run_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `resource_url_unique` ON `resource` (`url`);--> statement-breakpoint
CREATE INDEX `resource_kind_idx` ON `resource` (`kind`);--> statement-breakpoint
CREATE INDEX `resource_state_idx` ON `resource` (`state`);--> statement-breakpoint
CREATE INDEX `resource_host_idx` ON `resource` (`host`);--> statement-breakpoint
CREATE INDEX `resource_changed_idx` ON `resource` (`last_changed_at`);--> statement-breakpoint
CREATE TABLE `resource_version` (
	`id` text PRIMARY KEY NOT NULL,
	`resource_id` text NOT NULL,
	`run_id` text NOT NULL,
	`observed_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`change_kind` text NOT NULL,
	`http_status` integer,
	`content_type` text,
	`size_bytes` integer,
	`sha256` text,
	`etag` text,
	`last_modified` text,
	`blob_sha256` text,
	`title` text,
	FOREIGN KEY (`resource_id`) REFERENCES `resource`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`blob_sha256`) REFERENCES `blob`(`sha256`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `rv_resource_idx` ON `resource_version` (`resource_id`);--> statement-breakpoint
CREATE INDEX `rv_run_idx` ON `resource_version` (`run_id`);--> statement-breakpoint
CREATE INDEX `rv_observed_idx` ON `resource_version` (`observed_at`);--> statement-breakpoint
CREATE TABLE `sync_run` (
	`id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`control` text DEFAULT 'none' NOT NULL,
	`max_pages` integer,
	`params` text,
	`requested_by` text,
	`requested_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`worker_id` text,
	`heartbeat_at` integer,
	`current_url` text,
	`current_phase` text,
	`requests_made` integer DEFAULT 0 NOT NULL,
	`pages` integer DEFAULT 0 NOT NULL,
	`documents` integer DEFAULT 0 NOT NULL,
	`discovered` integer DEFAULT 0 NOT NULL,
	`fetched` integer DEFAULT 0 NOT NULL,
	`new_count` integer DEFAULT 0 NOT NULL,
	`changed_count` integer DEFAULT 0 NOT NULL,
	`unchanged_count` integer DEFAULT 0 NOT NULL,
	`gone_count` integer DEFAULT 0 NOT NULL,
	`error_count` integer DEFAULT 0 NOT NULL,
	`bytes_downloaded` integer DEFAULT 0 NOT NULL,
	`bytes_stored` integer DEFAULT 0 NOT NULL,
	`bytes_estimated` integer DEFAULT 0 NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `sync_run_status_idx` ON `sync_run` (`status`);--> statement-breakpoint
CREATE INDEX `sync_run_requested_idx` ON `sync_run` (`requested_at`);