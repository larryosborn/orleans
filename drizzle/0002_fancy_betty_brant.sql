ALTER TABLE `resource` ADD `priority` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `resource` ADD `next_fetch_at` integer;--> statement-breakpoint
CREATE INDEX `resource_frontier_idx` ON `resource` (`priority`,`next_fetch_at`);