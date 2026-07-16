import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

// Shared default: current time in epoch milliseconds, matching the auth schema.
const nowMs = sql`(cast(unixepoch('subsecond') * 1000 as integer))`;
const uuid = () => crypto.randomUUID();

// ---------------------------------------------------------------------------
// blob — content-addressed store. One row per unique file *content* (sha256).
// Identical bytes seen across many URLs/runs dedupe to a single object in R2,
// so `ref_count` drives storage-savings analytics and eventual GC.
// ---------------------------------------------------------------------------
export const blob = sqliteTable('blob', {
	sha256: text('sha256').primaryKey(),
	sizeBytes: integer('size_bytes').notNull(),
	contentType: text('content_type'),
	storageKey: text('storage_key').notNull(), // object key in R2
	refCount: integer('ref_count').notNull().default(0),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(nowMs).notNull()
});

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
		maxPages: integer('max_pages'),
		params: text('params'), // JSON blob for future knobs
		requestedBy: text('requested_by'), // user id
		requestedAt: integer('requested_at', { mode: 'timestamp_ms' }).default(nowMs).notNull(),
		startedAt: integer('started_at', { mode: 'timestamp_ms' }),
		finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
		workerId: text('worker_id'),
		heartbeatAt: integer('heartbeat_at', { mode: 'timestamp_ms' }),
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

export type Resource = typeof resource.$inferSelect;
export type ResourceVersion = typeof resourceVersion.$inferSelect;
export type Blob = typeof blob.$inferSelect;
export type Link = typeof link.$inferSelect;
export type SyncRun = typeof syncRun.$inferSelect;
export type CrawlEvent = typeof crawlEvent.$inferSelect;
