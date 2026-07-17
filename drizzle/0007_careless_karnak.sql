CREATE TABLE `worker` (
	`id` text PRIMARY KEY NOT NULL,
	`host` text NOT NULL,
	`pid` integer NOT NULL,
	`role` text DEFAULT 'standby' NOT NULL,
	`run_id` text,
	`phase` text,
	`started_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`last_seen_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `worker_last_seen_idx` ON `worker` (`last_seen_at`);--> statement-breakpoint
ALTER TABLE `sync_run` ADD `progress_at` integer;