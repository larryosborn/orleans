ALTER TABLE `blob` ADD `r2_synced_at` integer;--> statement-breakpoint
CREATE INDEX `blob_r2_synced_idx` ON `blob` (`r2_synced_at`);