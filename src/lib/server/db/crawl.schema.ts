import { sql } from 'drizzle-orm';
import {
	customType,
	sqliteTable,
	text,
	integer,
	index,
	uniqueIndex
} from 'drizzle-orm/sqlite-core';

// Shared default: current time in epoch milliseconds, matching the auth schema.
const nowMs = sql`(cast(unixepoch('subsecond') * 1000 as integer))`;
const uuid = () => crypto.randomUUID();

// ---------------------------------------------------------------------------
// blob — content-addressed store. One row per unique file *content* (sha256).
// Identical bytes seen across many URLs/runs dedupe to a single object in R2,
// so `ref_count` drives storage-savings analytics and eventual GC.
//
// R2 is the canonical durable archive, but publishing to it is opt-in. Every
// blob is first written to the local backend; `r2_synced_at` stays null until
// the object is *confirmed* present in R2 (a `--publish` write-through or a
// `blobs:push` promotion stamps it). So `r2_synced_at IS NULL` doubles as the
// "held / pending publish" queue.
// ---------------------------------------------------------------------------
export const blob = sqliteTable(
	'blob',
	{
		sha256: text('sha256').primaryKey(),
		sizeBytes: integer('size_bytes').notNull(),
		contentType: text('content_type'),
		storageKey: text('storage_key').notNull(), // content-addressed object key
		refCount: integer('ref_count').notNull().default(0),
		// null until the object is confirmed in R2 (the canonical archive); set on a
		// successful `--publish` write-through or a `blobs:push` promotion.
		r2SyncedAt: integer('r2_synced_at', { mode: 'timestamp_ms' }),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(nowMs).notNull()
	},
	(t) => [index('blob_r2_synced_idx').on(t.r2SyncedAt)]
);

// ---------------------------------------------------------------------------
// resource — one row per unique normalized URL. Stable identity across runs;
// carries the *latest* observed fingerprint plus lifecycle timestamps.
// ---------------------------------------------------------------------------
export const resource = sqliteTable(
	'resource',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		url: text('url').notNull().unique(),
		urlHash: text('url_hash').notNull(), // sha256(url) hex — stable lookup key
		host: text('host').notNull(),
		path: text('path').notNull(),
		kind: text('kind').notNull().default('page'), // page | document | sitemap | other
		contentType: text('content_type'),
		title: text('title'),
		httpStatus: integer('http_status'),
		state: text('state').notNull().default('active'), // active | gone | error
		// frontier scheduling: priority tier (0=core sitemap page … 3=doc) and when
		// this URL is next due for (re)fetch. Drives the resumable, freshness-aware
		// `sync` mode — see worker/crawl.ts executeSync.
		priority: integer('priority').notNull().default(1),
		nextFetchAt: integer('next_fetch_at', { mode: 'timestamp_ms' }),
		// latest observed content fingerprint
		sha256: text('sha256'), // null until a body has been stored (estimate = null)
		etag: text('etag'),
		lastModified: text('last_modified'),
		sizeBytes: integer('size_bytes'),
		latestVersionId: text('latest_version_id'),
		// lifecycle
		firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }).default(nowMs).notNull(),
		lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).default(nowMs).notNull(),
		lastFetchedAt: integer('last_fetched_at', { mode: 'timestamp_ms' }),
		lastChangedAt: integer('last_changed_at', { mode: 'timestamp_ms' }),
		firstRunId: text('first_run_id'),
		lastRunId: text('last_run_id')
	},
	(t) => [
		index('resource_kind_idx').on(t.kind),
		index('resource_state_idx').on(t.state),
		index('resource_host_idx').on(t.host),
		index('resource_changed_idx').on(t.lastChangedAt),
		index('resource_frontier_idx').on(t.priority, t.nextFetchAt)
	]
);

// ---------------------------------------------------------------------------
// resource_version — append-only change log. A row is written only when
// something meaningful happens: first capture (new), content changed, a probe
// recorded a size/etag (estimate), the URL went 404/410 (gone), or an error.
// Unchanged 304s do NOT create a row; they just touch resource.lastFetchedAt.
// ---------------------------------------------------------------------------
export const resourceVersion = sqliteTable(
	'resource_version',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		resourceId: text('resource_id')
			.notNull()
			.references(() => resource.id, { onDelete: 'cascade' }),
		runId: text('run_id').notNull(),
		observedAt: integer('observed_at', { mode: 'timestamp_ms' }).default(nowMs).notNull(),
		changeKind: text('change_kind').notNull(), // new | changed | probed | gone | error
		httpStatus: integer('http_status'),
		contentType: text('content_type'),
		sizeBytes: integer('size_bytes'),
		sha256: text('sha256'), // null for probe-only (HEAD/estimate) versions
		etag: text('etag'),
		lastModified: text('last_modified'),
		blobSha256: text('blob_sha256').references(() => blob.sha256),
		title: text('title')
	},
	(t) => [
		index('rv_resource_idx').on(t.resourceId),
		index('rv_run_idx').on(t.runId),
		index('rv_observed_idx').on(t.observedAt)
	]
);

// ---------------------------------------------------------------------------
// resource_text — cleaned, retrievable main-content plain text per resource, the
// input to the RAG pipeline (chunking/embedding, retrieval). Kept OUT of the blob
// store on purpose: it's derived, cheap to recompute, and queried relationally.
//
// Cached by *content* hash: `sha256` is the resource's content fingerprint the
// text was extracted from. A resource has at most one row (unique on
// resource_id); on a content change the row is overwritten with the new sha +
// text. So extraction skips a resource whose stored `sha256` already matches its
// row, and re-extracts when the content (hence the sha) changes.
//
// `status` is a closed set: `ok` (text extracted) | `empty` (parsed, no usable
// text) | `scanned` (image-only PDF, no text layer — NOT an error) | `unsupported`
// (a content type we don't extract, e.g. Office docs). `text` is populated only
// for `ok`. The `scanned` status is the queryable image-only-PDF census.
// ---------------------------------------------------------------------------
export const resourceText = sqliteTable(
	'resource_text',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		resourceId: text('resource_id')
			.notNull()
			.references(() => resource.id, { onDelete: 'cascade' }),
		// content fingerprint this text was extracted from (matches resource.sha256 /
		// blob.sha256). Drives the content-addressed cache — see the table comment.
		sha256: text('sha256').notNull(),
		contentType: text('content_type'), // the stored blob's content type (html / pdf / …)
		status: text('status').notNull(), // ok | empty | scanned | unsupported
		text: text('text'), // extracted plain text; null unless status = 'ok'
		charCount: integer('char_count').notNull().default(0),
		extractor: text('extractor'), // which seam produced it (e.g. html:readability, pdf:unpdf)
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(nowMs).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).default(nowMs).notNull()
	},
	(t) => [
		uniqueIndex('resource_text_resource_unique').on(t.resourceId),
		index('resource_text_sha_idx').on(t.sha256),
		index('resource_text_status_idx').on(t.status)
	]
);

// ---------------------------------------------------------------------------
// chunk — stage 2 of the RAG pipeline (#35). Each `resource_text` (status `ok`)
// is split into retrieval-sized pieces; every piece is embedded and stored here
// with its vector in a libSQL-native F32_BLOB column, so retrieval (#36) can run
// approximate-nearest-neighbour search with `vector_top_k` over `chunk_vec_idx`.
//
// `embedding` is a fixed-width float32 vector (see EMBED_DIM). It's stored as raw
// little-endian float32 bytes — byte-identical to what libSQL's `vector32()`
// produces — so `vector_top_k` / `vector_distance_cos` work directly on it. The
// `f32Blob` custom type maps `number[]` (app side) ↔ those bytes (driver side).
//
// Freshness is content-addressed like `resource_text`: `source_sha` is the
// `resource_text.sha256` these chunks were built from. Chunks are (re)built when
// that no longer matches the resource's current extracted-text sha, and a
// resource's chunks are deleted wholesale before rebuilding — so a content change
// leaves no orphan/stale chunks. `url` / `title` / `kind` are denormalized off
// `resource` so retrieval can filter + attribute a hit without a join.
//
// NOTE: the ANN index itself (`libsql_vector_idx(embedding)`) can't be expressed
// in Drizzle; it's created as raw SQL in the generated migration. Keep them in
// sync — see drizzle/*_*.sql for the `chunk_vec_idx` statement.
// ---------------------------------------------------------------------------

/** Dimensionality of stored embedding vectors, fixed at the F32_BLOB column
 *  width. The configured embedding model MUST emit this many dims: `bge-base` is
 *  768 natively; OpenAI `text-embedding-3-small` is requested with
 *  `dimensions: 768`; the deterministic fake embedder matches it. Changing this
 *  requires a new migration — libSQL vector columns are fixed-width. */
export const EMBED_DIM = 768;

/** libSQL-native float32 vector column. Presents as `number[]` in TypeScript and
 *  is stored as raw little-endian float32 bytes (the F32_BLOB wire format). */
const f32Blob = customType<{
	data: number[];
	driverData: Uint8Array;
	config: { dimensions: number };
}>({
	dataType(config) {
		return `F32_BLOB(${config?.dimensions ?? EMBED_DIM})`;
	},
	toDriver(value: number[]): Uint8Array {
		const f = Float32Array.from(value);
		return new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
	},
	fromDriver(value: Uint8Array): number[] {
		// libSQL hands back the blob as a Uint8Array/Buffer; decode to float32s.
		const bytes =
			value instanceof Uint8Array ? value : new Uint8Array(value as unknown as ArrayBuffer);
		const copy = bytes.slice(); // ensure a 4-byte-aligned, standalone buffer
		return Array.from(new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4));
	}
});

export const chunk = sqliteTable(
	'chunk',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		resourceId: text('resource_id')
			.notNull()
			.references(() => resource.id, { onDelete: 'cascade' }),
		// resource_text.sha256 these chunks were built from — the freshness key.
		sourceSha: text('source_sha').notNull(),
		chunkIndex: integer('chunk_index').notNull(), // 0-based order within the resource
		text: text('text').notNull(),
		// char offsets into the source resource_text.text (attribution / re-slicing).
		charStart: integer('char_start').notNull(),
		charEnd: integer('char_end').notNull(),
		embedding: f32Blob('embedding', { dimensions: EMBED_DIM }).notNull(),
		embedder: text('embedder'), // provenance: which model produced the vector
		// denormalized resource metadata for filter + attribution without a join.
		url: text('url').notNull(),
		title: text('title'),
		kind: text('kind').notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(nowMs).notNull()
	},
	(t) => [
		index('chunk_resource_idx').on(t.resourceId),
		index('chunk_source_sha_idx').on(t.sourceSha),
		uniqueIndex('chunk_resource_index_unique').on(t.resourceId, t.chunkIndex)
	]
);

// ---------------------------------------------------------------------------
// link — the discovered relation graph (who links to what). `to_resource_id`
// is backfilled when the target URL becomes a known resource; `to_url` always
// holds the raw normalized target so nothing is lost before that.
// ---------------------------------------------------------------------------
export const link = sqliteTable(
	'link',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		fromResourceId: text('from_resource_id')
			.notNull()
			.references(() => resource.id, { onDelete: 'cascade' }),
		toResourceId: text('to_resource_id').references(() => resource.id, { onDelete: 'set null' }),
		toUrl: text('to_url').notNull(),
		rel: text('rel').notNull().default('href'), // href | sitemap | seed | redirect
		firstRunId: text('first_run_id'),
		lastRunId: text('last_run_id'),
		lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).default(nowMs).notNull()
	},
	(t) => [
		uniqueIndex('link_from_to_unique').on(t.fromResourceId, t.toUrl),
		index('link_to_idx').on(t.toResourceId)
	]
);

// ---------------------------------------------------------------------------
// sync_run — one row per run. Doubles as the control plane: the web app inserts
// a row (status=queued) to *request* work and writes `control` to steer the
// active run; the worker claims it, heartbeats, obeys control, and writes the
// rollup counters the dashboard reads.
// ---------------------------------------------------------------------------
export const syncRun = sqliteTable(
	'sync_run',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		mode: text('mode').notNull(), // estimate | crawl | recrawl
		status: text('status').notNull().default('queued'), // queued|running|paused|completed|failed|canceled
		control: text('control').notNull().default('none'), // none | pause | resume | cancel
		// Frontier discovery switch. When true (default = today's behavior) the crawl
		// enqueues newly-discovered in-scope URLs; when false the worker keeps
		// fetching/refreshing already-known/queued resources but ingests no new links,
		// so it drains the known backlog. Steerable live from the dashboard; the worker
		// re-reads it on the heartbeat cadence (no restart needed).
		discoveryEnabled: integer('discovery_enabled', { mode: 'boolean' }).notNull().default(true),
		maxPages: integer('max_pages'),
		params: text('params'), // JSON blob for future knobs
		requestedBy: text('requested_by'), // user id
		requestedAt: integer('requested_at', { mode: 'timestamp_ms' }).default(nowMs).notNull(),
		startedAt: integer('started_at', { mode: 'timestamp_ms' }),
		finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
		workerId: text('worker_id'),
		heartbeatAt: integer('heartbeat_at', { mode: 'timestamp_ms' }),
		// Last time a forward-progress counter (requests-made / fetched) advanced —
		// bumped by the heartbeat ONLY when progress moved, never on a progress-less
		// beat. A run that keeps heartbeating while this stays put is "stalled" (a
		// dashboard warning; the worker never auto-fails on it). See writeHeartbeat.
		progressAt: integer('progress_at', { mode: 'timestamp_ms' }),
		currentUrl: text('current_url'),
		currentPhase: text('current_phase'),
		// rollups
		requestsMade: integer('requests_made').notNull().default(0),
		pages: integer('pages').notNull().default(0),
		documents: integer('documents').notNull().default(0),
		discovered: integer('discovered').notNull().default(0),
		fetched: integer('fetched').notNull().default(0),
		newCount: integer('new_count').notNull().default(0),
		changedCount: integer('changed_count').notNull().default(0),
		unchangedCount: integer('unchanged_count').notNull().default(0),
		goneCount: integer('gone_count').notNull().default(0),
		errorCount: integer('error_count').notNull().default(0),
		bytesDownloaded: integer('bytes_downloaded').notNull().default(0),
		bytesStored: integer('bytes_stored').notNull().default(0),
		bytesEstimated: integer('bytes_estimated').notNull().default(0),
		error: text('error') // fatal error, if the run failed
	},
	(t) => [
		index('sync_run_status_idx').on(t.status),
		index('sync_run_requested_idx').on(t.requestedAt)
	]
);

// ---------------------------------------------------------------------------
// worker — lightweight process registry. One row per live worker process,
// active AND standby. The single-writer guard means only the claiming worker
// touches a run row (see claimNext in worker/index.ts), so standbys and the
// total process count were previously invisible. Every worker upserts its own
// row (identity + role + last-seen) on the maintenance tick; the active worker
// also refreshes it on each crawl heartbeat so a long run never looks dead. A
// sweep drops rows older than the stale-run threshold, and a worker best-effort
// deletes its own row on shutdown, so the table reflects the live set.
// ---------------------------------------------------------------------------
export const worker = sqliteTable(
	'worker',
	{
		id: text('id').primaryKey(), // stable per-process id (host-pid-rand)
		host: text('host').notNull(),
		pid: integer('pid').notNull(),
		role: text('role').notNull().default('standby'), // active | standby
		runId: text('run_id'), // the run this worker owns, when active
		phase: text('phase'), // that run's current phase, when active
		startedAt: integer('started_at', { mode: 'timestamp_ms' }).default(nowMs).notNull(),
		lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).default(nowMs).notNull()
	},
	(t) => [index('worker_last_seen_idx').on(t.lastSeenAt)]
);

// ---------------------------------------------------------------------------
// crawl_event — per-URL errors and notable events for a run. Powers the
// dashboard "errors" panel and per-run drill-down.
// ---------------------------------------------------------------------------
export const crawlEvent = sqliteTable(
	'crawl_event',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		runId: text('run_id').notNull(),
		resourceId: text('resource_id'),
		url: text('url'),
		kind: text('kind').notNull(), // http_error | fetch_error | throttled | robots_blocked | redirect | skipped
		httpStatus: integer('http_status'),
		message: text('message'),
		at: integer('at', { mode: 'timestamp_ms' }).default(nowMs).notNull()
	},
	(t) => [index('crawl_event_run_idx').on(t.runId), index('crawl_event_kind_idx').on(t.kind)]
);

/** Closed set of extraction outcomes stored on `resource_text.status`. */
export type ExtractionStatus = 'ok' | 'empty' | 'scanned' | 'unsupported';

export type Resource = typeof resource.$inferSelect;
export type ResourceVersion = typeof resourceVersion.$inferSelect;
export type ResourceText = typeof resourceText.$inferSelect;
export type Chunk = typeof chunk.$inferSelect;
export type Blob = typeof blob.$inferSelect;
export type Link = typeof link.$inferSelect;
export type SyncRun = typeof syncRun.$inferSelect;
export type Worker = typeof worker.$inferSelect;
export type CrawlEvent = typeof crawlEvent.$inferSelect;
