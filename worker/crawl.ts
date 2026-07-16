// The crawl engine. Executes one sync_run end-to-end: BFS discovery from the
// sitemap + module seeds, conditional GETs for change detection, content-
// addressed blob storage, and full manifest/version/link bookkeeping in Turso.
// Honors run.control (pause/cancel) and writes heartbeats for the dashboard.
import { and, asc, eq, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { db } from './db';
import {
	blob,
	crawlEvent,
	link,
	resource,
	resourceVersion,
	syncRun
} from '../src/lib/server/db/schema';
import type { SyncRun } from '../src/lib/server/db/crawl.schema';
import { getStorage } from './storage';
import {
	BASE_URL,
	docExtFor,
	MAX_DOC_BYTES,
	MAX_PAGES,
	priorityFor,
	RATE_LIMIT_JITTER,
	RATE_LIMIT_SECONDS,
	SEED_PATHS,
	SYNC_BATCH,
	SYNC_ERROR_BACKOFF_MS,
	ttlFor
} from './config';
import {
	extractLinks,
	filenameHint,
	hostOf,
	inScope,
	normalize,
	normalizeHtml,
	pageTitle,
	parseSitemap,
	parseSitemapEntries,
	pathOf,
	politeFetch,
	Robots,
	sha256Hex
} from './http';

const HEARTBEAT_MS = 2000;

/** Pause between requests: the base rate limit plus random jitter (0..N s). */
function politeDelay(): Promise<void> {
	return Bun.sleep((RATE_LIMIT_SECONDS + Math.random() * RATE_LIMIT_JITTER) * 1000);
}

interface Stats {
	requestsMade: number;
	pages: number;
	documents: number;
	discovered: number;
	fetched: number;
	newCount: number;
	changedCount: number;
	unchangedCount: number;
	goneCount: number;
	errorCount: number;
	bytesDownloaded: number;
	bytesStored: number;
	bytesEstimated: number;
}

function zeroStats(): Stats {
	return {
		requestsMade: 0,
		pages: 0,
		documents: 0,
		discovered: 0,
		fetched: 0,
		newCount: 0,
		changedCount: 0,
		unchangedCount: 0,
		goneCount: 0,
		errorCount: 0,
		bytesDownloaded: 0,
		bytesStored: 0,
		bytesEstimated: 0
	};
}

type Mode = 'estimate' | 'crawl' | 'recrawl' | 'sync';

interface IngestCtx {
	url: string;
	prevId?: string;
	prevSha: string | null;
	prevSize: number | null;
	mode: Mode;
	maxDocBytes: number | undefined;
	runId: string;
	stats: Stats;
}

/**
 * Handle a 200 response: record the document/page (respecting estimate + the
 * document size limit), upsert its links, and return the in-scope URLs it
 * discovered (anchor targets, or sitemap `<loc>`s). Shared by the BFS loop and
 * the frontier `sync` loop so their fetch handling can't drift apart.
 */
async function ingestResponse(resp: Response, ctx: IngestCtx): Promise<string[]> {
	const { url, prevId, prevSha, prevSize, mode, maxDocBytes, runId, stats } = ctx;
	const ctype = (resp.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
	const etag = resp.headers.get('ETag') ?? undefined;
	const lastModified = resp.headers.get('Last-Modified') ?? undefined;
	const ext = docExtFor(ctype);

	if (ext) {
		// -------- document --------
		stats.documents++;
		const download = mode !== 'estimate';
		const clen = Number(resp.headers.get('Content-Length') ?? '');
		const knownSize = Number.isFinite(clen) && clen > 0 ? clen : null;
		// estimate never downloads; crawl/recrawl skip docs over the size limit.
		const skipBody =
			!download ||
			(maxDocBytes !== undefined &&
				(maxDocBytes <= 0 || (knownSize !== null && knownSize > maxDocBytes)));

		if (skipBody) {
			resp.body?.cancel();
			stats.bytesEstimated += knownSize ?? 0;
			await recordObservation({
				runId,
				url,
				prevId,
				prevSha,
				prevSize,
				kind: 'document',
				contentType: ctype,
				httpStatus: 200,
				size: knownSize ?? 0,
				sha: null,
				etag,
				lastModified,
				blobSha: null,
				title: filenameHint(resp) ?? null,
				stats
			});
		} else {
			const bytes = new Uint8Array(await resp.arrayBuffer());
			const size = bytes.byteLength;
			const sha = sha256Hex(bytes);
			stats.bytesDownloaded += size;
			const blobSha =
				sha !== prevSha ? await ensureBlob(sha, ext, bytes, ctype, size, stats) : null;
			await recordObservation({
				runId,
				url,
				prevId,
				prevSha,
				prevSize,
				kind: 'document',
				contentType: ctype,
				httpStatus: 200,
				size,
				sha,
				etag,
				lastModified,
				blobSha,
				title: filenameHint(resp) ?? null,
				stats
			});
		}
		return [];
	}

	if (ctype.includes('html') || ctype.includes('xml')) {
		const text = await resp.text();
		// Sitemap? return its locs for the caller to enqueue; don't store it.
		if (
			url.endsWith('sitemap.xml') ||
			text.slice(0, 500).includes('<urlset') ||
			text.slice(0, 500).includes('<sitemapindex')
		) {
			return parseSitemap(text)
				.map((l) => normalize(l))
				.filter((u) => inScope(u));
		}

		// -------- page --------
		stats.pages++;
		const size = Buffer.byteLength(text, 'utf8');
		const title = pageTitle(text) ?? null;
		let sha: string | null = null;
		let blobSha: string | null = null;
		if (mode === 'estimate') {
			stats.bytesEstimated += size;
		} else {
			// Hash + store the normalized HTML so re-fetches of an unchanged page
			// don't produce false `changed` versions or near-duplicate blobs.
			const normalized = normalizeHtml(text);
			sha = sha256Hex(normalized);
			stats.bytesDownloaded += size; // bytes actually fetched (original)
			if (sha !== prevSha) {
				const bytes = new TextEncoder().encode(normalized);
				blobSha = await ensureBlob(sha, '.html', bytes, ctype, bytes.byteLength, stats);
			}
		}
		const resourceId = await recordObservation({
			runId,
			url,
			prevId,
			prevSha,
			prevSize,
			kind: 'page',
			contentType: ctype,
			httpStatus: 200,
			size,
			sha,
			etag,
			lastModified,
			blobSha,
			title,
			stats
		});

		// Relations + discovery. Batch the link upserts (hub pages have hundreds).
		const targets = new Set<string>();
		for (const l of extractLinks(url, text)) if (inScope(l)) targets.add(l);
		await batchAll([...targets].map((t) => linkUpsertStmt(resourceId, t, runId)));
		return [...targets];
	}

	resp.body?.cancel(); // images, etc. — ignored
	return [];
}

export async function executeRun(run: SyncRun): Promise<void> {
	const mode = run.mode as Mode;
	const runId = run.id;
	const maxPages = run.maxPages ?? MAX_PAGES;

	// Optional document size limit: docs bigger than this are recorded but not
	// downloaded (HTML is always fetched). Per-run params override the env default.
	// undefined = download all documents; 0 = skip all (pages-only).
	const params = run.params ? (JSON.parse(run.params) as { maxDocBytes?: number }) : {};
	const maxDocBytes = typeof params.maxDocBytes === 'number' ? params.maxDocBytes : MAX_DOC_BYTES;
	// Blob store is chosen by env (R2 in prod, local cache in dev — see storage.ts).
	// Only crawl/recrawl write bodies; estimate never touches it.
	if (mode !== 'estimate') console.log(`blob store: ${getStorage().label}`);

	const robots = await Robots.load(BASE_URL);
	const stats = zeroStats();
	const seen = new Set<string>();
	const queue: string[] = [];
	for (const p of SEED_PATHS) queue.push(normalize(p, BASE_URL));

	// recrawl revisits everything already known, to pick up changes.
	if (mode === 'recrawl') {
		const rows = await db.select({ url: resource.url }).from(resource);
		for (const r of rows) queue.push(r.url);
	}

	let control: string = run.control;
	let lastBeat = 0;

	async function beat(currentUrl: string | null): Promise<void> {
		const nowMs = Date.now();
		if (nowMs - lastBeat < HEARTBEAT_MS) return;
		lastBeat = nowMs;
		control = await writeHeartbeat(runId, currentUrl, stats);
	}

	// Mark running.
	await db
		.update(syncRun)
		.set({ status: 'running', startedAt: new Date(), currentPhase: 'crawling' })
		.where(eq(syncRun.id, runId));

	while (queue.length > 0 && stats.requestsMade < maxPages) {
		const url = queue.shift()!;
		if (seen.has(url) || !inScope(url)) continue;
		seen.add(url);

		// Control: react to pause/cancel between requests.
		await beat(url);
		if (control === 'cancel') break;
		while (control === 'pause') {
			await db.update(syncRun).set({ status: 'paused' }).where(eq(syncRun.id, runId));
			await Bun.sleep(1500);
			lastBeat = 0;
			await beat(url);
			if (control === 'cancel') break;
			if (control !== 'pause') {
				await db.update(syncRun).set({ status: 'running' }).where(eq(syncRun.id, runId));
			}
		}
		if (control === 'cancel') break;

		if (!robots.canFetch(url)) {
			await logEvent(runId, url, 'robots_blocked', null, null);
			continue;
		}

		// Existing manifest row drives conditional GET + change detection.
		const existing = await db
			.select({
				id: resource.id,
				sha256: resource.sha256,
				etag: resource.etag,
				lastModified: resource.lastModified,
				sizeBytes: resource.sizeBytes,
				lastFetchedAt: resource.lastFetchedAt
			})
			.from(resource)
			.where(eq(resource.url, url))
			.limit(1);
		const prev = existing[0];

		// Plain crawl skips URLs already captured; recrawl/estimate re-check.
		if (prev && prev.lastFetchedAt && mode === 'crawl') continue;

		const headers: Record<string, string> = {};
		if (prev && mode === 'recrawl') {
			if (prev.etag) headers['If-None-Match'] = prev.etag;
			if (prev.lastModified) headers['If-Modified-Since'] = prev.lastModified;
		}

		const { resp, throttled, error } = await politeFetch(url, headers);
		stats.requestsMade++;
		if (throttled) await logEvent(runId, url, 'throttled', null, null);

		if (!resp) {
			stats.errorCount++;
			await logEvent(runId, url, 'fetch_error', null, error ?? 'no response');
			await recordFailure(runId, url, prev?.id, 0, 'error');
			await politeDelay();
			continue;
		}
		if (resp.status === 304) {
			stats.unchangedCount++;
			if (prev) await touchFetched(prev.id, runId);
			resp.body?.cancel();
			await politeDelay();
			continue;
		}
		if (resp.status !== 200) {
			resp.body?.cancel();
			stats.errorCount++;
			await logEvent(runId, url, 'http_error', resp.status, null);
			if (resp.status === 404 || resp.status === 410) {
				stats.goneCount++;
				await recordGone(runId, url, prev?.id, resp.status);
			} else {
				await recordFailure(runId, url, prev?.id, resp.status, 'error');
			}
			await politeDelay();
			continue;
		}
		stats.fetched++;
		const targets = await ingestResponse(resp, {
			url,
			prevId: prev?.id,
			prevSha: prev?.sha256 ?? null,
			prevSize: prev?.sizeBytes ?? null,
			mode,
			maxDocBytes,
			runId,
			stats
		});
		for (const t of targets) {
			if (!seen.has(t)) {
				queue.push(t);
				stats.discovered++;
			}
		}

		await politeDelay();
	}

	// Backfill link targets to resource ids in one pass, then finalize.
	await backfillLinkTargets();
	await finalizeRun(runId, control === 'cancel' ? 'canceled' : 'completed', stats);
}

// ---------------------------------------------------------------------------
// sync — resumable, priority-ordered, freshness-driven frontier crawl.
//
// Instead of an in-memory BFS queue rebuilt each run, the `resource` table IS
// the queue: every URL has a `priority` tier (0 = core sitemap page … 3 = doc)
// and a `nextFetchAt` (when it's due). A run drains all *due* resources in
// priority order, reschedules each with a per-tier TTL, and enqueues newly
// discovered URLs as due-now — so core pages finish before the long tail, and
// the run picks up exactly where it left off, only fetching what's stale.
// ---------------------------------------------------------------------------
export async function executeSync(run: SyncRun): Promise<void> {
	const runId = run.id;
	const maxPages = run.maxPages ?? MAX_PAGES;
	const params = run.params ? (JSON.parse(run.params) as { maxDocBytes?: number }) : {};
	const maxDocBytes = typeof params.maxDocBytes === 'number' ? params.maxDocBytes : MAX_DOC_BYTES;
	console.log(`blob store: ${getStorage().label}`);

	const robots = await Robots.load(BASE_URL);
	const stats = zeroStats();
	let control: string = run.control;
	let lastBeat = 0;

	async function beat(currentUrl: string | null): Promise<void> {
		const nowMs = Date.now();
		if (nowMs - lastBeat < HEARTBEAT_MS) return;
		lastBeat = nowMs;
		control = await writeHeartbeat(runId, currentUrl, stats);
	}

	/** Wait out a pause; returns false if the run was canceled. */
	async function awaitResume(url: string | null): Promise<boolean> {
		while (control === 'pause') {
			await db.update(syncRun).set({ status: 'paused' }).where(eq(syncRun.id, runId));
			await Bun.sleep(1500);
			lastBeat = 0;
			await beat(url);
			if (control === 'cancel') return false;
			if (control !== 'pause') {
				await db.update(syncRun).set({ status: 'running' }).where(eq(syncRun.id, runId));
			}
		}
		return control !== 'cancel';
	}

	const schedule = (id: string, priority: number) =>
		db
			.update(resource)
			.set({ nextFetchAt: new Date(Date.now() + ttlFor(priority)) })
			.where(eq(resource.id, id));

	await db
		.update(syncRun)
		.set({ status: 'running', startedAt: new Date(), currentPhase: 'sync' })
		.where(eq(syncRun.id, runId));

	// Backfill: give any legacy rows a priority tier (they were all default 1).
	await db.run(
		sql`UPDATE ${resource} SET priority = CASE
			WHEN url LIKE '%/DocumentCenter/View/%' THEN 3
			WHEN url LIKE '%/AgendaCenter/ViewFile/%' THEN 2
			ELSE 1 END
			WHERE priority = 1`
	);

	await refreshSeeds(runId, stats);

	// Drain the due frontier in priority order until nothing is due (caught up).
	while (stats.requestsMade < maxPages) {
		await beat(null);
		if (control === 'cancel' || !(await awaitResume(null))) break;

		const batch = await db
			.select({
				id: resource.id,
				url: resource.url,
				priority: resource.priority,
				sha256: resource.sha256,
				etag: resource.etag,
				lastModified: resource.lastModified,
				sizeBytes: resource.sizeBytes
			})
			.from(resource)
			.where(
				and(
					or(isNull(resource.nextFetchAt), lte(resource.nextFetchAt, new Date())),
					ne(resource.state, 'gone')
				)
			)
			// Completeness before freshness: fetch never-seen URLs first (in priority
			// order), then re-verify already-have ones. So we capture new content
			// (e.g. thousands of documents) before re-checking pages we already hold.
			.orderBy(
				sql`${resource.lastFetchedAt} is null desc`,
				asc(resource.priority),
				asc(resource.nextFetchAt)
			)
			.limit(SYNC_BATCH);
		if (batch.length === 0) break; // caught up

		for (const r of batch) {
			if (stats.requestsMade >= maxPages) break;
			await beat(r.url);
			if (control === 'cancel' || !(await awaitResume(r.url))) break;

			if (!inScope(r.url)) {
				await schedule(r.id, r.priority);
				continue;
			}
			if (!robots.canFetch(r.url)) {
				await logEvent(runId, r.url, 'robots_blocked', null, null);
				await schedule(r.id, r.priority);
				continue;
			}

			// Always conditional-GET in sync (cheap 304s for unchanged content).
			const headers: Record<string, string> = {};
			if (r.etag) headers['If-None-Match'] = r.etag;
			if (r.lastModified) headers['If-Modified-Since'] = r.lastModified;

			const { resp, throttled, error } = await politeFetch(r.url, headers);
			stats.requestsMade++;
			if (throttled) await logEvent(runId, r.url, 'throttled', null, null);

			if (!resp) {
				stats.errorCount++;
				await logEvent(runId, r.url, 'fetch_error', null, error ?? 'no response');
				await recordFailure(runId, r.url, r.id, 0, 'error');
				await db
					.update(resource)
					.set({ nextFetchAt: new Date(Date.now() + SYNC_ERROR_BACKOFF_MS) })
					.where(eq(resource.id, r.id));
				await politeDelay();
				continue;
			}
			if (resp.status === 304) {
				stats.unchangedCount++;
				await touchFetched(r.id, runId);
				await schedule(r.id, r.priority);
				resp.body?.cancel();
				await politeDelay();
				continue;
			}
			if (resp.status !== 200) {
				resp.body?.cancel();
				stats.errorCount++;
				await logEvent(runId, r.url, 'http_error', resp.status, null);
				if (resp.status === 404 || resp.status === 410) {
					stats.goneCount++;
					await recordGone(runId, r.url, r.id, resp.status);
					// Gone: park it far in the future so it isn't re-fetched.
					await db
						.update(resource)
						.set({ nextFetchAt: new Date(Date.now() + 365 * 86_400_000) })
						.where(eq(resource.id, r.id));
				} else {
					await recordFailure(runId, r.url, r.id, resp.status, 'error');
					await db
						.update(resource)
						.set({ nextFetchAt: new Date(Date.now() + SYNC_ERROR_BACKOFF_MS) })
						.where(eq(resource.id, r.id));
				}
				await politeDelay();
				continue;
			}

			stats.fetched++;
			const discovered = await ingestResponse(resp, {
				url: r.url,
				prevId: r.id,
				prevSha: r.sha256,
				prevSize: r.sizeBytes,
				mode: 'sync',
				maxDocBytes,
				runId,
				stats
			});
			await schedule(r.id, r.priority);
			const fresh = discovered.filter((t) => !t.endsWith('sitemap.xml'));
			await batchAll(fresh.map((t) => enqueueResourceStmt(t, runId)));
			stats.discovered += fresh.length;
			await politeDelay();
		}
		if (control === 'cancel') break;
	}

	await backfillLinkTargets();
	await finalizeRun(runId, control === 'cancel' ? 'canceled' : 'completed', stats);
}

/** Seed the frontier: module roots (tier 1) + sitemap core pages (tier 0). */
async function refreshSeeds(runId: string, stats: Stats): Promise<void> {
	const roots = SEED_PATHS.map((p) => normalize(p, BASE_URL)).filter(
		(u) => !u.endsWith('sitemap.xml') && inScope(u)
	);
	await batchAll(roots.map((u) => enqueueResourceStmt(u, runId))); // module roots, tier 1, due now

	const { resp } = await politeFetch(`${BASE_URL}/sitemap.xml`, {});
	stats.requestsMade++;
	if (!resp || resp.status !== 200) {
		resp?.body?.cancel();
		return;
	}
	const entries = parseSitemapEntries(await resp.text());

	// Upsert every sitemap URL as a core page (tier 0). New ones become due now;
	// existing ones keep their schedule (so fresh pages aren't re-fetched).
	const now = new Date();
	const stmts = entries
		.map((e) => normalize(e.loc))
		.filter((u) => inScope(u))
		.map((u) =>
			db
				.insert(resource)
				.values({
					url: u,
					urlHash: sha256Hex(u),
					host: hostOf(u),
					path: pathOf(u),
					kind: 'page',
					priority: 0,
					nextFetchAt: now,
					firstRunId: runId,
					lastRunId: runId
				})
				.onConflictDoUpdate({ target: resource.url, set: { priority: 0 } })
		);
	await batchAll(stmts);

	// Proactive freshness: make an existing core page due now if the sitemap's
	// <lastmod> is newer than when we last saw it change. Match on the exact
	// (case-sensitive) URL — the sitemap's <loc> is the canonical row we upserted
	// above; matching case-insensitively would collide with case-variant rows.
	const known = await db
		.select({ url: resource.url, lastChangedAt: resource.lastChangedAt })
		.from(resource);
	const changedAt = new Map(known.map((r) => [r.url, r.lastChangedAt?.getTime() ?? 0]));
	const dueNow = entries
		.filter((e) => e.lastmod)
		.map((e) => ({ u: normalize(e.loc), lm: Date.parse(e.lastmod!) }))
		.filter(({ u, lm }) => {
			const seen = changedAt.get(u);
			return Number.isFinite(lm) && seen !== undefined && lm > seen;
		})
		.map(({ u }) => db.update(resource).set({ nextFetchAt: now }).where(eq(resource.url, u)));
	if (dueNow.length) await batchAll(dueNow);

	await politeDelay();
}

/** Build an insert that adds a discovered URL to the frontier (due now) if
 *  absent. Batched by callers; on conflict we keep the existing schedule. */
function enqueueResourceStmt(url: string, runId: string) {
	return db
		.insert(resource)
		.values({
			url,
			urlHash: sha256Hex(url),
			host: hostOf(url),
			path: pathOf(url),
			kind: 'page',
			priority: priorityFor(url),
			nextFetchAt: new Date(),
			firstRunId: runId,
			lastRunId: runId
		})
		.onConflictDoNothing({ target: resource.url });
}

function backfillLinkTargets(): Promise<unknown> {
	return db.run(
		sql`UPDATE ${link} SET to_resource_id = (SELECT id FROM ${resource} WHERE ${resource}.url = ${link}.to_url) WHERE to_resource_id IS NULL`
	);
}

/** Write heartbeat + rollup counters; returns the current control flag. */
async function writeHeartbeat(
	runId: string,
	currentUrl: string | null,
	stats: Stats
): Promise<string> {
	const [row] = await db
		.update(syncRun)
		.set({
			heartbeatAt: new Date(),
			currentUrl,
			requestsMade: stats.requestsMade,
			pages: stats.pages,
			documents: stats.documents,
			discovered: stats.discovered,
			fetched: stats.fetched,
			newCount: stats.newCount,
			changedCount: stats.changedCount,
			unchangedCount: stats.unchangedCount,
			goneCount: stats.goneCount,
			errorCount: stats.errorCount,
			bytesDownloaded: stats.bytesDownloaded,
			bytesStored: stats.bytesStored,
			bytesEstimated: stats.bytesEstimated
		})
		.where(eq(syncRun.id, runId))
		.returning({ control: syncRun.control });
	return row?.control ?? 'none';
}

async function finalizeRun(runId: string, status: string, stats: Stats): Promise<void> {
	await db
		.update(syncRun)
		.set({
			status,
			finishedAt: new Date(),
			currentUrl: null,
			currentPhase: null,
			heartbeatAt: new Date(),
			requestsMade: stats.requestsMade,
			pages: stats.pages,
			documents: stats.documents,
			discovered: stats.discovered,
			fetched: stats.fetched,
			newCount: stats.newCount,
			changedCount: stats.changedCount,
			unchangedCount: stats.unchangedCount,
			goneCount: stats.goneCount,
			errorCount: stats.errorCount,
			bytesDownloaded: stats.bytesDownloaded,
			bytesStored: stats.bytesStored,
			bytesEstimated: stats.bytesEstimated
		})
		.where(eq(syncRun.id, runId));
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------
interface Observation {
	runId: string;
	url: string;
	prevId?: string;
	prevSha: string | null;
	prevSize: number | null;
	kind: string;
	contentType: string;
	httpStatus: number;
	size: number;
	sha: string | null; // null in estimate mode
	etag?: string;
	lastModified?: string;
	blobSha: string | null;
	title: string | null;
	stats: Stats;
}

/** Upsert a resource and, when something changed, append a version row. */
async function recordObservation(o: Observation): Promise<string> {
	const now = new Date();
	const resourceId = await upsertResource({
		url: o.url,
		kind: o.kind,
		contentType: o.contentType,
		title: o.title,
		httpStatus: o.httpStatus,
		sha: o.sha,
		etag: o.etag ?? null,
		lastModified: o.lastModified ?? null,
		size: o.size,
		runId: o.runId,
		now
	});

	// Decide what kind of change this is. Note prevSha is null both for a brand-new
	// URL and for a stub row enqueued by sync that hasn't been fetched yet — either
	// way, the first time we hash a body it's `new`, not `changed`.
	let changeKind: 'new' | 'changed' | 'probed' | 'unchanged';
	if (o.sha !== null) {
		changeKind = o.prevSha === null ? 'new' : o.sha === o.prevSha ? 'unchanged' : 'changed';
	} else if (!o.prevId || o.prevSize !== o.size) {
		// estimate/probe: no prior, or a size delta since last probe
		changeKind = 'probed';
	} else {
		changeKind = 'unchanged';
	}

	if (changeKind === 'unchanged') {
		o.stats.unchangedCount++;
		return resourceId;
	}

	if (changeKind === 'new') o.stats.newCount++;
	else if (changeKind === 'changed') o.stats.changedCount++;

	const [ver] = await db
		.insert(resourceVersion)
		.values({
			resourceId,
			runId: o.runId,
			changeKind,
			httpStatus: o.httpStatus,
			contentType: o.contentType,
			sizeBytes: o.size,
			sha256: o.sha,
			etag: o.etag ?? null,
			lastModified: o.lastModified ?? null,
			blobSha256: o.blobSha,
			title: o.title
		})
		.returning({ id: resourceVersion.id });

	await db
		.update(resource)
		.set({ latestVersionId: ver.id, lastChangedAt: now })
		.where(eq(resource.id, resourceId));

	return resourceId;
}

interface ResourceUpsert {
	url: string;
	kind: string;
	contentType: string;
	title: string | null;
	httpStatus: number;
	sha: string | null;
	etag: string | null;
	lastModified: string | null;
	size: number | null;
	runId: string;
	now: Date;
}

async function upsertResource(r: ResourceUpsert): Promise<string> {
	const [row] = await db
		.insert(resource)
		.values({
			url: r.url,
			urlHash: sha256Hex(r.url),
			host: hostOf(r.url),
			path: pathOf(r.url),
			kind: r.kind,
			contentType: r.contentType,
			title: r.title,
			httpStatus: r.httpStatus,
			state: 'active',
			sha256: r.sha,
			etag: r.etag,
			lastModified: r.lastModified,
			sizeBytes: r.size,
			lastSeenAt: r.now,
			lastFetchedAt: r.now,
			firstRunId: r.runId,
			lastRunId: r.runId
		})
		.onConflictDoUpdate({
			target: resource.url,
			set: {
				kind: r.kind,
				contentType: r.contentType,
				title: r.title,
				httpStatus: r.httpStatus,
				state: 'active',
				// keep prior sha when this observation didn't hash a body (estimate)
				sha256: r.sha ?? sql`${resource.sha256}`,
				etag: r.etag,
				lastModified: r.lastModified,
				sizeBytes: r.size,
				lastSeenAt: r.now,
				lastFetchedAt: r.now,
				lastRunId: r.runId
			}
		})
		.returning({ id: resource.id });
	return row.id;
}

/** Content-addressed store: upload if new, dedupe otherwise; track refcount. */
async function ensureBlob(
	sha: string,
	ext: string,
	bytes: Uint8Array,
	contentType: string,
	size: number,
	stats: Stats
): Promise<string> {
	const existing = await db
		.select({ sha256: blob.sha256 })
		.from(blob)
		.where(eq(blob.sha256, sha))
		.limit(1);
	if (existing.length === 0) {
		const key = await getStorage().putIfAbsent(sha, ext, bytes, contentType);
		await db
			.insert(blob)
			.values({ sha256: sha, sizeBytes: size, contentType, storageKey: key, refCount: 1 })
			.onConflictDoUpdate({ target: blob.sha256, set: { refCount: sql`${blob.refCount} + 1` } });
		stats.bytesStored += size; // newly stored bytes (dedup savings = downloaded - stored)
	} else {
		await db
			.update(blob)
			.set({ refCount: sql`${blob.refCount} + 1` })
			.where(eq(blob.sha256, sha));
	}
	return sha;
}

/** Build (don't execute) a link upsert, so callers can batch many per round-trip. */
function linkUpsertStmt(fromId: string, toUrl: string, runId: string) {
	return db
		.insert(link)
		.values({ fromResourceId: fromId, toUrl, rel: 'href', firstRunId: runId, lastRunId: runId })
		.onConflictDoUpdate({
			target: [link.fromResourceId, link.toUrl],
			set: { lastRunId: runId, lastSeenAt: new Date() }
		});
}

/** Execute drizzle statements in chunked batches (one round-trip per chunk). */
async function batchAll(stmts: unknown[]): Promise<void> {
	const CHUNK = 100;
	for (let i = 0; i < stmts.length; i += CHUNK) {
		const slice = stmts.slice(i, i + CHUNK);
		if (slice.length) await db.batch(slice as Parameters<typeof db.batch>[0]);
	}
}

async function touchFetched(resourceId: string, runId: string): Promise<void> {
	await db
		.update(resource)
		.set({ lastFetchedAt: new Date(), lastSeenAt: new Date(), lastRunId: runId })
		.where(eq(resource.id, resourceId));
}

async function recordGone(
	runId: string,
	url: string,
	prevId: string | undefined,
	status: number
): Promise<void> {
	const id =
		prevId ??
		(await upsertResource({
			url,
			kind: 'page',
			contentType: '',
			title: null,
			httpStatus: status,
			sha: null,
			etag: null,
			lastModified: null,
			size: null,
			runId,
			now: new Date()
		}));
	await db
		.update(resource)
		.set({ state: 'gone', httpStatus: status, lastFetchedAt: new Date() })
		.where(eq(resource.id, id));
	await db
		.insert(resourceVersion)
		.values({ resourceId: id, runId, changeKind: 'gone', httpStatus: status });
}

async function recordFailure(
	runId: string,
	url: string,
	prevId: string | undefined,
	status: number,
	state: string
): Promise<void> {
	if (!prevId) return; // don't create a manifest row for a URL we never had
	await db
		.update(resource)
		.set({ state, httpStatus: status, lastFetchedAt: new Date() })
		.where(eq(resource.id, prevId));
	await db
		.insert(resourceVersion)
		.values({ resourceId: prevId, runId, changeKind: 'error', httpStatus: status });
}

async function logEvent(
	runId: string,
	url: string,
	kind: string,
	httpStatus: number | null,
	message: string | null
): Promise<void> {
	await db.insert(crawlEvent).values({ runId, url, kind, httpStatus, message });
}
