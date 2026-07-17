CREATE TABLE `resource_text` (
	`id` text PRIMARY KEY NOT NULL,
	`resource_id` text NOT NULL,
	`sha256` text NOT NULL,
	`content_type` text,
	`status` text NOT NULL,
	`text` text,
	`char_count` integer DEFAULT 0 NOT NULL,
	`extractor` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`resource_id`) REFERENCES `resource`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `resource_text_resource_unique` ON `resource_text` (`resource_id`);--> statement-breakpoint
CREATE INDEX `resource_text_sha_idx` ON `resource_text` (`sha256`);--> statement-breakpoint
CREATE INDEX `resource_text_status_idx` ON `resource_text` (`status`);