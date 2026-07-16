// Server-side control plane + read models for the sync dashboard. The web app
// never talks to the worker directly: it enqueues sync_run rows and writes the
// `control` column; the worker polls, executes, and writes back progress here.
import { and, count, desc, eq, inArray, like, or, sql } from 'drizzle-orm';
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

export async function getRecentRuns(limit = 10) {
	return db.select().from(syncRun).orderBy(desc(syncRun.requestedAt)).limit(limit);
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
