// Cleaned-text R2 exporter (#63) — the INDEXING side of the AI Search adapter.
//
// AI Search (rag/search.ts) can only cite what it indexes, and the content-addressed
// `blob`s in R2 are the RAW scrape: nav-heavy, sha256-keyed, and carrying NO
// source-URL metadata — the wrong layer to feed a retrieval index. This mode writes
// the CLEAN layer instead: for every resource whose extraction landed `ok` (#34),
// it publishes the cleaned `resource_text` as one object under a dedicated R2
// prefix (`index/`), tagged with custom metadata so a hit maps back to a real
// Orleans URL:
//
//   index/<resourceId>.md   (text/markdown)
//     x-amz-meta-source-url : the resource's URL   (≤500 chars, AI Search's limit)
//     x-amz-meta-title      : the resource's title (≤500 chars)
//     x-amz-meta-kind       : page | document | …
//
// WHY NOT worker/storage.ts's Bun S3Client: Bun's native `S3Client.write()` options
// (S3Options) expose acl/type/storageClass/contentDisposition but have NO field for
// custom `x-amz-meta-*` metadata (confirmed against bun-types s3.d.ts / the Bun S3
// docs). So the metadata this index depends on can't be set through that path. We
// use aws4fetch instead — already a dependency, already the app's R2 signer
// (src/lib/server/blob.ts) — which signs a plain PUT with arbitrary headers.
//
// Skips: non-`ok` resources (nothing clean to index) and any object over 4 MB — both
// logged via the structured logger, never errored.
import { and, asc, eq, gt } from 'drizzle-orm';
import { AwsClient } from 'aws4fetch';
import { crawlEvent, resource, resourceText, syncRun } from '../src/lib/server/db/schema';
import type { SyncRun } from '../src/lib/server/db/crawl.schema';
import { runLogger } from './log';

// `db` + `registry` are imported LAZILY inside executeIndexExport (below) so the
// pure/writer helpers here — buildIndexObject / makeR2IndexWriter — stay import-safe
// without a configured DATABASE_URL (tests exercise them directly). Mirrors the same
// lazy-db seam in rag/retrieve.ts.

/** R2 prefix the export lands under (kept separate from `blobs/`). */
export const INDEX_PREFIX = 'index/';
/** Objects larger than this are skipped — AI Search's per-file ceiling. */
export const MAX_OBJECT_BYTES = 4 * 1024 * 1024;
/** AI Search truncates custom metadata values at 500 chars; we do it up front. */
export const META_VALUE_MAX = 500;

const HEARTBEAT_MS = 2000;
const BATCH = 200; // resources per DB round-trip

/** Custom metadata attached to each exported object (→ `x-amz-meta-*`). */
export interface IndexObjectMeta {
	sourceUrl: string;
	title: string;
	kind: string;
}

/** A ready-to-write index object, or a reason it was skipped. */
export type IndexObject =
	{ key: string; bytes: Uint8Array; contentType: string; meta: IndexObjectMeta } | { skip: string };

/** One resource's extraction row, as selected for export. */
export interface ExportRow {
	resourceId: string;
	url: string;
	title: string | null;
	kind: string;
	status: string;
	text: string | null;
}

/** Strip a value to a valid, single-line ASCII HTTP-header ByteString and truncate
 *  to AI Search's 500-char metadata limit. Non-ASCII (e.g. a title's em-dash) is
 *  dropped rather than encoded — attribution rides on the ASCII source URL, and a
 *  header can't carry raw Unicode. */
export function sanitizeMetaValue(raw: string | null | undefined): string {
	return (raw ?? '')
		.replace(/[\r\n\t]+/g, ' ')
		.replace(/[^\x20-\x7E]/g, '')
		.trim()
		.slice(0, META_VALUE_MAX);
}

/**
 * Decide what (if anything) to export for one resource. Pure + injectable so the
 * selection/skip/truncation rules are unit-testable without a DB or R2:
 *   • non-`ok` status or blank text → skip (nothing clean to index),
 *   • text over `maxBytes` → skip (too big for AI Search),
 *   • otherwise a `index/<resourceId>.md` object + source-url/title/kind metadata.
 */
export function buildIndexObject(row: ExportRow, maxBytes = MAX_OBJECT_BYTES): IndexObject {
	if (row.status !== 'ok') return { skip: `status ${row.status} (not ok)` };
	const text = row.text ?? '';
	if (!text.trim()) return { skip: 'empty text' };

	const bytes = new TextEncoder().encode(text);
	if (bytes.length > maxBytes) {
		return { skip: `oversize (${bytes.length} bytes > ${maxBytes})` };
	}

	return {
		key: `${INDEX_PREFIX}${row.resourceId}.md`,
		bytes,
		contentType: 'text/markdown; charset=utf-8',
		meta: {
			sourceUrl: sanitizeMetaValue(row.url),
			title: sanitizeMetaValue(row.title),
			kind: sanitizeMetaValue(row.kind) || 'page'
		}
	};
}

// ---------------------------------------------------------------------------
// The index writer — a plain PUT to R2 with custom metadata headers, signed by
// aws4fetch. Injectable so the exporter can be driven against a stub S3 server.
// ---------------------------------------------------------------------------
export interface IndexWriter {
	readonly label: string;
	put(key: string, bytes: Uint8Array, contentType: string, meta: IndexObjectMeta): Promise<void>;
}

export interface R2WriterConfig {
	endpoint: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
}

/** Build the R2 index writer from config (defaults to R2_* env). Returns null when
 *  R2 isn't configured — the run then fails fast with a clear message. */
export function makeR2IndexWriter(cfg: Partial<R2WriterConfig> = {}): IndexWriter | null {
	const endpoint = cfg.endpoint ?? process.env.R2_ENDPOINT;
	const bucket = cfg.bucket ?? process.env.R2_BUCKET;
	const accessKeyId = cfg.accessKeyId ?? process.env.R2_ACCESS_KEY_ID;
	const secretAccessKey = cfg.secretAccessKey ?? process.env.R2_SECRET_ACCESS_KEY;
	if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;

	const client = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' });
	const base = endpoint.replace(/\/$/, '');
	return {
		label: `R2 index writer (${bucket}/${INDEX_PREFIX})`,
		async put(key, bytes, contentType, meta) {
			const url = `${base}/${bucket}/${key}`;
			const res = await client.fetch(url, {
				method: 'PUT',
				// aws4fetch signs x-amz-* headers, so this metadata is part of the request.
				headers: {
					'content-type': contentType,
					'x-amz-meta-source-url': meta.sourceUrl,
					'x-amz-meta-title': meta.title,
					'x-amz-meta-kind': meta.kind
				},
				body: bytes
			});
			if (!res.ok) {
				const detail = await res.text().catch(() => '');
				throw new Error(`R2 PUT ${key} failed (${res.status})${detail ? `: ${detail}` : ''}`);
			}
		}
	};
}

// ---------------------------------------------------------------------------
// The export run.
// ---------------------------------------------------------------------------
interface ExportStats {
	processed: number; // resources we looked at this run
	written: number; // objects written to the index prefix
	skipped: number; // non-ok / oversize
	errors: number;
}

function zero(): ExportStats {
	return { processed: 0, written: 0, skipped: 0, errors: 0 };
}

/**
 * Export cleaned text for every `ok` resource to the R2 `index/` prefix with
 * source-URL/title/kind metadata. Mirrors extract/embed's run scaffolding
 * (heartbeat, pause/cancel, syncRun lifecycle); the writer is injectable so tests
 * point it at a stub S3 server.
 */
export async function executeIndexExport(
	run: SyncRun,
	opts: { writer?: IndexWriter } = {}
): Promise<void> {
	const runId = run.id;
	const maxPages = run.maxPages ?? Infinity; // --max caps processed count (testing)
	const log = runLogger('index-export', run, 'indexing');
	// Lazy so the module stays import-safe without DATABASE_URL (see note up top).
	const { db } = await import('./db');
	const { refreshActiveWorker } = await import('./registry');
	const writer = opts.writer ?? makeR2IndexWriter();
	if (!writer) {
		throw new Error(
			'index-export requires R2_* env vars (R2_ENDPOINT / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY).'
		);
	}
	const stats = zero();
	let control: string = run.control;
	let lastBeat = 0;

	async function beat(currentUrl: string | null): Promise<void> {
		const nowMs = Date.now();
		if (nowMs - lastBeat < HEARTBEAT_MS) return;
		lastBeat = nowMs;
		await refreshActiveWorker(run.workerId, runId, 'indexing');
		const [row] = await db
			.update(syncRun)
			.set({ heartbeatAt: new Date(), currentUrl })
			.where(eq(syncRun.id, runId))
			.returning({ control: syncRun.control });
		control = row?.control ?? 'none';
	}

	await db
		.update(syncRun)
		.set({ status: 'running', startedAt: new Date(), currentPhase: 'indexing' })
		.where(eq(syncRun.id, runId));

	log.info({ writer: writer.label }, 'index export started');

	// Walk every `ok` resource_text (only `ok` carries clean text) joined to its
	// resource for the source URL / title / kind attribution.
	let cursor = '';
	while (stats.processed < maxPages) {
		await beat(null);
		if (control === 'cancel') break;
		while (control === 'pause') {
			await db.update(syncRun).set({ status: 'paused' }).where(eq(syncRun.id, runId));
			await Bun.sleep(1500);
			lastBeat = 0;
			await beat(null);
			if (control === 'cancel') break;
			if (control !== 'pause') {
				await db.update(syncRun).set({ status: 'running' }).where(eq(syncRun.id, runId));
			}
		}
		if (control === 'cancel') break;

		const batch = await db
			.select({
				rtId: resourceText.id,
				resourceId: resourceText.resourceId,
				status: resourceText.status,
				text: resourceText.text,
				url: resource.url,
				title: resource.title,
				kind: resource.kind
			})
			.from(resourceText)
			.innerJoin(resource, eq(resource.id, resourceText.resourceId))
			.where(and(gt(resourceText.id, cursor), eq(resourceText.status, 'ok')))
			.orderBy(asc(resourceText.id))
			.limit(BATCH);
		if (batch.length === 0) break; // caught up

		for (const r of batch) {
			if (stats.processed >= maxPages) break;
			cursor = r.rtId;
			await beat(r.url);
			if (control === 'cancel') break;

			try {
				const obj = buildIndexObject({
					resourceId: r.resourceId,
					url: r.url,
					title: r.title,
					kind: r.kind,
					status: r.status,
					text: r.text
				});
				stats.processed++;
				if ('skip' in obj) {
					stats.skipped++;
					log.info({ url: r.url, resourceId: r.resourceId, reason: obj.skip }, 'index export skip');
					continue;
				}
				await writer.put(obj.key, obj.bytes, obj.contentType, obj.meta);
				stats.written++;
			} catch (e) {
				stats.errors++;
				const msg = e instanceof Error ? e.message : String(e);
				await db.insert(crawlEvent).values({
					runId,
					resourceId: r.resourceId,
					url: r.url,
					kind: 'index_export_error',
					message: `index export failed: ${msg}`.slice(0, 500)
				});
				log.error({ err: e, url: r.url, resourceId: r.resourceId }, 'index export failed');
			}
		}
	}

	const status = control === 'cancel' ? 'canceled' : 'completed';
	await db
		.update(syncRun)
		.set({
			status,
			finishedAt: new Date(),
			currentUrl: null,
			currentPhase: null,
			heartbeatAt: new Date()
		})
		.where(eq(syncRun.id, runId));

	log.info(
		{
			status,
			processed: stats.processed,
			written: stats.written,
			skipped: stats.skipped,
			errors: stats.errors
		},
		'index export finished'
	);
}
