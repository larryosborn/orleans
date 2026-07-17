CREATE TABLE `chunk` (
	`id` text PRIMARY KEY NOT NULL,
	`resource_id` text NOT NULL,
	`source_sha` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`text` text NOT NULL,
	`char_start` integer NOT NULL,
	`char_end` integer NOT NULL,
	`embedding` F32_BLOB(768) NOT NULL,
	`embedder` text,
	`url` text NOT NULL,
	`title` text,
	`kind` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`resource_id`) REFERENCES `resource`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chunk_resource_idx` ON `chunk` (`resource_id`);--> statement-breakpoint
CREATE INDEX `chunk_source_sha_idx` ON `chunk` (`source_sha`);--> statement-breakpoint
CREATE UNIQUE INDEX `chunk_resource_index_unique` ON `chunk` (`resource_id`,`chunk_index`);--> statement-breakpoint
-- libSQL-native ANN index over the F32_BLOB `embedding` column (cosine metric),
-- so retrieval can run `vector_top_k('chunk_vec_idx', vector32(?), k)`. This
-- cannot be expressed in Drizzle, so it lives here as raw SQL — keep it in sync
-- with the `chunk.embedding` column in src/lib/server/db/crawl.schema.ts.
CREATE INDEX `chunk_vec_idx` ON `chunk` (libsql_vector_idx(`embedding`, 'metric=cosine'));