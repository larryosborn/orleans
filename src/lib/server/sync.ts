// Server-side control plane + read models for the sync dashboard. The web app
// never talks to the worker directly: it enqueues sync_run rows and writes the
// `control` column; the worker polls, executes, and writes back progress here.
import { and, count, desc, eq, inArray, isNotNull, isNull, like, or, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { blob, crawlEvent, link, resource, resourceVersion, syncRun } from '$lib/server/db/schema';

export type SyncMode = 'sync' | 'estimate' | 'crawl' | 'recrawl';
export type ControlAction = 'pause' | 'resume' | 'cancel';

const ACTIVE_STATUSES = ['queued', 'running', 'paused'] as const;

// ---------------------------------------------------------------------------
// Control
// ---------------------------------------------------------------------------
export async function enqueueRun(
	mode: SyncMode,
	opts: { maxPages?: number | null; maxDocBytes?: number | null; userId?: string } = {}
): Promise<string> {
	// maxDocBytes: skip downloading documents larger than this (0 = skip all docs,
	// i.e. pages-only). Stored in params so the worker picks it up.
	const params =
		opts.maxDocBytes != null ? JSON.stringify({ maxDocBytes: opts.maxDocBytes }) : null;
	const [row] = await db
		.insert(syncRun)
		.values({
			mode,
			status: 'queued',
			maxPages: opts.maxPages ?? null,
			params,
			requestedBy: opts.userId ?? null
		})
		.returning({ id: syncRun.id });
	return row.id;
}

export async function setControl(runId: string, action: ControlAction): Promise<void> {
	// resume clears the control flag; the worker flips paused -> running itself.
	const control = action === 'resume' ? 'none' : action;
	await db.update(syncRun).set({ control }).where(eq(syncRun.id, runId));
}

/** Toggle frontier discovery for a run. Off = the worker keeps fetching/refreshing
 *  known/queued resources but stops enqueuing newly-discovered URLs; on = resume
 *  discovery. Independent of pause/cancel; the worker re-reads it live on its
 *  heartbeat cadence, so no restart is needed. */
export async function setDiscovery(runId: string, enabled: boolean): Promise<void> {
	await db.update(syncRun).set({ discoveryEnabled: enabled }).where(eq(syncRun.id, runId));
}

/** The run currently occupying the worker (or most-recently queued), if any. */
export async function getActiveRun() {
	const [row] = await db
		.select()
		.from(syncRun)
		.where(inArray(syncRun.status, [...ACTIVE_STATUSES]))
		.orderBy(desc(syncRun.requestedAt))
		.limit(1);
	return row ?? null;
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------
export async function getOverview() {
	const [totals] = await db
		.select({
			resources: count(),
			documents: sql<number>`sum(case when ${resource.kind} = 'document' then 1 else 0 end)`,
			pages: sql<number>`sum(case when ${resource.kind} = 'page' then 1 else 0 end)`,
			gone: sql<number>`sum(case when ${resource.state} = 'gone' then 1 else 0 end)`,
			logicalBytes: sql<number>`coalesce(sum(${resource.sizeBytes}), 0)`
		})
		.from(resource);

	const [blobs] = await db
		.select({
			objects: count(),
			storedBytes: sql<number>`coalesce(sum(${blob.sizeBytes}), 0)`,
			refs: sql<number>`coalesce(sum(${blob.refCount}), 0)`
		})
		.from(blob);

	const [links] = await db.select({ total: count() }).from(link);
	const [versions] = await db.select({ total: count() }).from(resourceVersion);

	return {
		resources: totals?.resources ?? 0,
		documents: Number(totals?.documents ?? 0),
		pages: Number(totals?.pages ?? 0),
		gone: Number(totals?.gone ?? 0),
		logicalBytes: Number(totals?.logicalBytes ?? 0),
		storedBytes: Number(blobs?.storedBytes ?? 0),
		blobObjects: blobs?.objects ?? 0,
		blobRefs: Number(blobs?.refs ?? 0),
		links: links?.total ?? 0,
		versions: versions?.total ?? 0
	};
}

/** How many blobs are held locally but not yet confirmed in R2 (the canonical
 *  archive) — i.e. `r2_synced_at IS NULL`. This is the "pending publish" backlog
 *  that a `--publish` run or `blobs:push` drains. Exposed for the dashboard /
 *  publish tooling to surface; not rendered here. */
export async function getUnpublishedBlobCount(): Promise<number> {
	const [row] = await db.select({ n: count() }).from(blob).where(isNull(blob.r2SyncedAt));
	return row?.n ?? 0;
}

export async function getRecentRuns(limit = 10) {
	return db.select().from(syncRun).orderBy(desc(syncRun.requestedAt)).limit(limit);
}

/** One cache-age bucket: how many stored blobs fall into an age window (by
 *  `blob.createdAt`, relative to now). Empty buckets are still returned so the
 *  distribution renders a stable set of columns. */
export interface CacheAgeBucket {
	label: string;
	count: number;
}

/** Storage + cache-health aggregates for the dashboard's storage panel. All
 *  derived from today's schema — no per-blob backend/location column:
 *  - stored size & object count come from the content-addressed `blob` table;
 *  - cache age (oldest / newest / distribution) from `blob.createdAt`;
 *  - `unpublishedBlobs` (r2_synced_at IS NULL) is the pending-publish backlog;
 *  - health signals count resources stale past their refresh-due time plus the
 *    error / gone lifecycle states.
 *  Every field is coalesced/guarded so an empty DB reads as zeroes, never a
 *  divide-by-zero or a null. */
export interface StorageHealth {
	storedBytes: number;
	blobObjects: number;
	unpublishedBlobs: number;
	/** Epoch ms of the oldest / newest stored blob, or null when the store is empty. */
	oldestBlobAt: number | null;
	newestBlobAt: number | null;
	/** Cache-age distribution over stored blobs (<1d / 1–7d / 7–30d / >30d). */
	ageBuckets: CacheAgeBucket[];
	/** Health signals. `stalePastDue`: active resources whose refresh is due
	 *  (`nextFetchAt` <= now); `errorResources` / `goneResources`: lifecycle states. */
	stalePastDue: number;
	errorResources: number;
	goneResources: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function getStorageHealth(): Promise<StorageHealth> {
	const now = Date.now();
	const d1 = now - DAY_MS;
	const d7 = now - 7 * DAY_MS;
	const d30 = now - 30 * DAY_MS;

	// Blob store: totals, cache-age extremes, and the age distribution in one pass.
	// createdAt is a timestamp_ms column, so it compares directly against epoch ms.
	const [b] = await db
		.select({
			objects: count(),
			storedBytes: sql<number>`coalesce(sum(${blob.sizeBytes}), 0)`,
			oldest: sql<number | null>`min(${blob.createdAt})`,
			newest: sql<number | null>`max(${blob.createdAt})`,
			under1d: sql<number>`sum(case when ${blob.createdAt} >= ${d1} then 1 else 0 end)`,
			d1to7: sql<number>`sum(case when ${blob.createdAt} < ${d1} and ${blob.createdAt} >= ${d7} then 1 else 0 end)`,
			d7to30: sql<number>`sum(case when ${blob.createdAt} < ${d7} and ${blob.createdAt} >= ${d30} then 1 else 0 end)`,
			over30d: sql<number>`sum(case when ${blob.createdAt} < ${d30} then 1 else 0 end)`
		})
		.from(blob);

	const [unpublished] = await db.select({ n: count() }).from(blob).where(isNull(blob.r2SyncedAt));

	// Health signals over resources: refresh-due backlog + error/gone lifecycle.
	const [h] = await db
		.select({
			stalePastDue: sql<number>`sum(case when ${resource.state} = 'active' and ${resource.nextFetchAt} is not null and ${resource.nextFetchAt} <= ${now} then 1 else 0 end)`,
			errorResources: sql<number>`sum(case when ${resource.state} = 'error' then 1 else 0 end)`,
			goneResources: sql<number>`sum(case when ${resource.state} = 'gone' then 1 else 0 end)`
		})
		.from(resource);

	return {
		storedBytes: Number(b?.storedBytes ?? 0),
		blobObjects: b?.objects ?? 0,
		unpublishedBlobs: unpublished?.n ?? 0,
		oldestBlobAt: b?.oldest != null ? Number(b.oldest) : null,
		newestBlobAt: b?.newest != null ? Number(b.newest) : null,
		ageBuckets: [
			{ label: '< 1d', count: Number(b?.under1d ?? 0) },
			{ label: '1–7d', count: Number(b?.d1to7 ?? 0) },
			{ label: '7–30d', count: Number(b?.d7to30 ?? 0) },
			{ label: '> 30d', count: Number(b?.over30d ?? 0) }
		],
		stalePastDue: Number(h?.stalePastDue ?? 0),
		errorResources: Number(h?.errorResources ?? 0),
		goneResources: Number(h?.goneResources ?? 0)
	};
}

/** One coverage bucket for a resource `kind` (page / document / sitemap / other):
 *  how many of that kind have been fetched vs discovered. `kind` is assigned at
 *  discovery time (independent of fetch), so `total` is a stable denominator — unlike
 *  `contentType`, which is null until a body is fetched and would make totals drift. */
export interface SyncProgressBucket {
	kind: string;
	label: string;
	total: number;
	fetched: number;
}

// Preferred display order + human labels for the known kinds; unknown kinds sort
// last and fall back to their raw value as the label. Keeps rendering data-driven
// (only kinds that exist get a bar) while giving a stable, legible ordering.
const KIND_LABELS: Record<string, string> = {
	page: 'Pages',
	document: 'Documents',
	sitemap: 'Sitemaps',
	other: 'Other'
};
const KIND_ORDER = ['page', 'document', 'sitemap', 'other'];
const kindRank = (kind: string) => {
	const i = KIND_ORDER.indexOf(kind);
	return i === -1 ? KIND_ORDER.length : i;
};

export interface SyncProgress {
	totalResources: number;
	fetched: number;
	dueRemaining: number;
	/** Per-content-type coverage, one entry per resource `kind` present. Empty when
	 *  nothing has been discovered yet. Zero-total kinds never appear (grouped query). */
	byType: SyncProgressBucket[];
	// Core-vs-Documents roll-up, kept for backward derivability. These are crawl
	// *priority tier* based (core = priority 0, docs = priority >= 2), a different cut
	// than `byType`'s kind buckets, so the original headline stays reconstructable.
	coreTotal: number;
	coreFetched: number;
	docTotal: number;
	docFetched: number;
	documents: number;
	blobObjects: number;
	storedBytes: number;
}

/** Live archive progress, for the sync status card. `fetched / totalResources` is
 *  the overall roll-up; `byType` breaks coverage down per content type; `dueRemaining`
 *  is the frontier work left. */
export async function getSyncProgress(): Promise<SyncProgress> {
	const now = Date.now();
	const [r] = await db
		.select({
			total: count(),
			fetched: sql<number>`sum(case when ${resource.lastFetchedAt} is not null then 1 else 0 end)`,
			dueRemaining: sql<number>`sum(case when ${resource.state} != 'gone' and (${resource.nextFetchAt} is null or ${resource.nextFetchAt} <= ${now}) then 1 else 0 end)`,
			coreTotal: sql<number>`sum(case when ${resource.priority} = 0 then 1 else 0 end)`,
			coreFetched: sql<number>`sum(case when ${resource.priority} = 0 and ${resource.lastFetchedAt} is not null then 1 else 0 end)`,
			docTotal: sql<number>`sum(case when ${resource.priority} >= 2 then 1 else 0 end)`,
			docFetched: sql<number>`sum(case when ${resource.priority} >= 2 and ${resource.lastFetchedAt} is not null then 1 else 0 end)`,
			documents: sql<number>`sum(case when ${resource.kind} = 'document' and ${resource.lastFetchedAt} is not null then 1 else 0 end)`
		})
		.from(resource);
	// Per-kind coverage — grouped so only kinds that actually exist produce a bucket
	// (no divide-by-zero downstream, since total >= 1 for every returned row).
	const typeRows = await db
		.select({
			kind: resource.kind,
			total: count(),
			fetched: sql<number>`sum(case when ${resource.lastFetchedAt} is not null then 1 else 0 end)`
		})
		.from(resource)
		.groupBy(resource.kind);
	const byType: SyncProgressBucket[] = typeRows
		.map((t) => ({
			kind: t.kind,
			label: KIND_LABELS[t.kind] ?? t.kind,
			total: Number(t.total),
			fetched: Number(t.fetched)
		}))
		.sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || a.kind.localeCompare(b.kind));
	const [b] = await db
		.select({ objects: count(), bytes: sql<number>`coalesce(sum(${blob.sizeBytes}), 0)` })
		.from(blob);
	return {
		totalResources: r?.total ?? 0,
		fetched: Number(r?.fetched ?? 0),
		dueRemaining: Number(r?.dueRemaining ?? 0),
		byType,
		coreTotal: Number(r?.coreTotal ?? 0),
		coreFetched: Number(r?.coreFetched ?? 0),
		docTotal: Number(r?.docTotal ?? 0),
		docFetched: Number(r?.docFetched ?? 0),
		documents: Number(r?.documents ?? 0),
		blobObjects: b?.objects ?? 0,
		storedBytes: Number(b?.bytes ?? 0)
	};
}

export async function getLastCompletedRun() {
	const [row] = await db
		.select()
		.from(syncRun)
		.where(inArray(syncRun.status, ['completed', 'failed', 'canceled']))
		.orderBy(desc(syncRun.finishedAt))
		.limit(1);
	return row ?? null;
}

export async function getRun(id: string) {
	const [row] = await db.select().from(syncRun).where(eq(syncRun.id, id)).limit(1);
	return row ?? null;
}

/** Error/notable events, newest first, for the errors panel or a run. */
export async function getEvents(opts: { runId?: string; limit?: number } = {}) {
	const where = opts.runId ? eq(crawlEvent.runId, opts.runId) : undefined;
	return db
		.select()
		.from(crawlEvent)
		.where(where)
		.orderBy(desc(crawlEvent.at))
		.limit(opts.limit ?? 50);
}

export async function getEventCounts(runId?: string) {
	const where = runId ? eq(crawlEvent.runId, runId) : undefined;
	return db
		.select({ kind: crawlEvent.kind, n: count() })
		.from(crawlEvent)
		.where(where)
		.groupBy(crawlEvent.kind)
		.orderBy(desc(count()));
}

/** Storage/cache breakdown by content type (from the manifest). */
export async function getStorageByType(limit = 8) {
	return db
		.select({
			contentType: sql<string>`coalesce(${resource.contentType}, 'unknown')`,
			n: count(),
			bytes: sql<number>`coalesce(sum(${resource.sizeBytes}), 0)`
		})
		.from(resource)
		.groupBy(sql`coalesce(${resource.contentType}, 'unknown')`)
		.orderBy(desc(sql`coalesce(sum(${resource.sizeBytes}), 0)`))
		.limit(limit);
}

/** Content explorer: paginated resource list with optional search/filter. */
export async function listResources(opts: {
	q?: string;
	kind?: string;
	state?: string;
	limit?: number;
	offset?: number;
}) {
	const filters = [];
	if (opts.q)
		filters.push(or(like(resource.url, `%${opts.q}%`), like(resource.title, `%${opts.q}%`)));
	if (opts.kind) filters.push(eq(resource.kind, opts.kind));
	if (opts.state) filters.push(eq(resource.state, opts.state));
	const where = filters.length ? and(...filters) : undefined;

	const rows = await db
		.select({
			id: resource.id,
			url: resource.url,
			title: resource.title,
			kind: resource.kind,
			state: resource.state,
			contentType: resource.contentType,
			sizeBytes: resource.sizeBytes,
			sha256: resource.sha256,
			httpStatus: resource.httpStatus,
			lastFetchedAt: resource.lastFetchedAt,
			lastChangedAt: resource.lastChangedAt
		})
		.from(resource)
		.where(where)
		.orderBy(desc(resource.lastChangedAt), desc(resource.lastSeenAt))
		.limit(opts.limit ?? 50)
		.offset(opts.offset ?? 0);

	const [{ total }] = await db.select({ total: count() }).from(resource).where(where);
	return { rows, total };
}

// Closed value sets for the enriched fields, mirroring the schema's documented
// column domains (see crawl.schema.ts). Kept as unions so consumers stay
// exhaustive; the DB stores them as plain text, so reads are cast at the boundary.
export type ResourceKind = 'page' | 'document' | 'sitemap' | 'other';
export type ResourceState = 'active' | 'gone' | 'error';
export type ChangeKind = 'new' | 'changed' | 'probed' | 'gone' | 'error';

export interface ProcessingRecord {
	id: string;
	url: string;
	title: string | null;
	// type
	kind: ResourceKind;
	contentType: string | null;
	// current status: resource lifecycle + latest change outcome
	state: ResourceState;
	httpStatus: number | null;
	currentOutcome: ChangeKind | null; // latest resource_version.changeKind
	currentAt: number | null; // latest resource_version.observedAt
	// previous status: the outcome recorded *before* the latest version
	previousOutcome: ChangeKind | null; // 2nd-newest resource_version.changeKind
	// cache age
	fetchedAt: number | null; // resource.lastFetchedAt
}

export interface ProcessingPanel {
	records: ProcessingRecord[];
	/** True when more fetched resources exist than the panel shows (truncated). */
	hasMore: boolean;
}

/** "Currently processing": the most-recently *fetched* resources, newest first —
 *  a compact window on what the worker just touched. Unlike the change feed it
 *  includes unchanged re-verifies (every fetch bumps `lastFetchedAt`), so it keeps
 *  moving even when nothing changes. Each record is enriched from its resource row
 *  (type, current state/status) and the append-only version log: the latest
 *  version's outcome (current) and the one before it (previous). Fetches `limit + 1`
 *  rows so the caller can flag truncation without a second count query. */
export async function getProcessingRecords(limit = 3): Promise<ProcessingPanel> {
	const resources = await db
		.select({
			id: resource.id,
			url: resource.url,
			title: resource.title,
			kind: resource.kind,
			contentType: resource.contentType,
			state: resource.state,
			httpStatus: resource.httpStatus,
			lastFetchedAt: resource.lastFetchedAt
		})
		.from(resource)
		.where(isNotNull(resource.lastFetchedAt))
		.orderBy(desc(resource.lastFetchedAt))
		.limit(limit + 1);

	const hasMore = resources.length > limit;

	// Enrich each shown resource with its two newest version rows — [current,
	// previous] — via a small indexed lookup (rv_resource_idx). A per-resource
	// query keeps the correlation correct and bounded to the handful of rows the
	// panel shows, rather than a correlated subquery in the list select.
	const records: ProcessingRecord[] = await Promise.all(
		resources.slice(0, limit).map(async (r) => {
			const versions = await db
				.select({
					changeKind: resourceVersion.changeKind,
					observedAt: resourceVersion.observedAt
				})
				.from(resourceVersion)
				.where(eq(resourceVersion.resourceId, r.id))
				.orderBy(desc(resourceVersion.observedAt))
				.limit(2);
			const [current, previous] = versions;
			// Cast the text columns to their documented unions at the read boundary.
			return {
				id: r.id,
				url: r.url,
				title: r.title,
				kind: r.kind as ResourceKind,
				contentType: r.contentType,
				state: r.state as ResourceState,
				httpStatus: r.httpStatus,
				currentOutcome: (current?.changeKind ?? null) as ChangeKind | null,
				currentAt: current?.observedAt?.getTime() ?? null,
				previousOutcome: (previous?.changeKind ?? null) as ChangeKind | null,
				fetchedAt: r.lastFetchedAt?.getTime() ?? null
			};
		})
	);
	return { records, hasMore };
}

/** Change feed: recent version rows joined to their resource. */
export async function getChangeFeed(limit = 25) {
	return db
		.select({
			id: resourceVersion.id,
			changeKind: resourceVersion.changeKind,
			observedAt: resourceVersion.observedAt,
			sizeBytes: resourceVersion.sizeBytes,
			httpStatus: resourceVersion.httpStatus,
			url: resource.url,
			title: resource.title,
			kind: resource.kind
		})
		.from(resourceVersion)
		.innerJoin(resource, eq(resource.id, resourceVersion.resourceId))
		.where(inArray(resourceVersion.changeKind, ['new', 'changed', 'gone']))
		.orderBy(desc(resourceVersion.observedAt))
		.limit(limit);
}
