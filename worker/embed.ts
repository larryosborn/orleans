// Embedding pipeline — stage 2 of the RAG pipeline (#35). Turns the cleaned
// extracted text (`resource_text`, status `ok`, from #34) into retrieval-ready
// vectors: chunk → embed → store in `chunk` (a libSQL-native F32_BLOB column with
// an ANN index), so retrieval (#36) can `vector_top_k` over it.
//
// Freshness mirrors extraction's content-addressed cache. Each chunk records the
// `resource_text.sha256` it was built from (`source_sha`). A resource is
// (re)processed only when that no longer matches — i.e. the extracted text is new
// or changed — and its chunks are deleted wholesale before rebuilding, so a
// content change re-embeds ONLY that resource and never leaves orphan/stale
// chunks. A resource whose text stops being `ok` (empty/scanned/unsupported) has
// its chunks removed too. So a re-run over unchanged content does no work.
import { and, asc, eq, gt, or, sql } from 'drizzle-orm';
import { db } from './db';
import {
	chunk,
	crawlEvent,
	resource,
	resourceText,
	syncRun,
	worker
} from '../src/lib/server/db/schema';
import type { SyncRun } from '../src/lib/server/db/crawl.schema';
import { EMBED_BATCH } from './config';
import { chunkText } from './chunk';
import { selectEmbedder, type Embedder } from './embeddings';

const HEARTBEAT_MS = 2000;
const BATCH = 200; // resources per DB round-trip
const INSERT_CHUNK_ROWS = 100; // chunk rows per insert statement (SQLite var limit)

interface EmbedStats {
	processed: number; // resource_text rows we (re)built or cleared this run
	rebuilt: number; // resources chunked + embedded
	cleared: number; // resources whose (now non-ok) chunks were removed
	chunks: number; // chunk rows written
	errors: number;
}

function zero(): EmbedStats {
	return { processed: 0, rebuilt: 0, cleared: 0, chunks: 0, errors: 0 };
}

/** Rebuild one resource's chunks: delete existing, then chunk + embed + insert.
 *  Returns the number of chunk rows written. */
async function rebuildResource(
	row: {
		resourceId: string;
		sha256: string;
		text: string;
		url: string;
		title: string | null;
		kind: string;
	},
	embedder: Embedder
): Promise<number> {
	const pieces = chunkText(row.text);

	const now = new Date();
	// Embed OUTSIDE the transaction — it's the slow, network-bound part, and we
	// don't want a hosted-model round-trip holding a write transaction open.
	const pending: (typeof chunk.$inferInsert)[] = [];
	for (let i = 0; i < pieces.length; i += EMBED_BATCH) {
		const batch = pieces.slice(i, i + EMBED_BATCH);
		const vectors = await embedder.embed(batch.map((p) => p.text));
		for (let j = 0; j < batch.length; j++) {
			const p = batch[j];
			pending.push({
				resourceId: row.resourceId,
				sourceSha: row.sha256,
				chunkIndex: p.index,
				text: p.text,
				charStart: p.charStart,
				charEnd: p.charEnd,
				embedding: vectors[j],
				embedder: embedder.id,
				url: row.url,
				title: row.title,
				kind: row.kind,
				createdAt: now
			});
		}
	}

	// Swap old chunks for new atomically: delete-then-insert in one transaction so
	// a mid-insert failure can't leave a resource half-chunked but carrying the new
	// source_sha (which would make the freshness predicate skip it forever).
	await db.transaction(async (tx) => {
		await tx.delete(chunk).where(eq(chunk.resourceId, row.resourceId));
		for (let i = 0; i < pending.length; i += INSERT_CHUNK_ROWS) {
			await tx.insert(chunk).values(pending.slice(i, i + INSERT_CHUNK_ROWS));
		}
	});
	return pending.length;
}

export async function executeEmbed(
	run: SyncRun,
	opts: { embedder?: Embedder } = {}
): Promise<void> {
	const runId = run.id;
	const maxPages = run.maxPages ?? Infinity; // --max caps processed resources (testing)
	const embedder = selectEmbedder(opts.embedder);
	const stats = zero();
	let control: string = run.control;
	let lastBeat = 0;

	// Heartbeat keeps the run alive and reads back the control word. Like extract,
	// it deliberately does NOT touch the crawl-specific rollup counters — the
	// authoritative chunk census is `select count(*) from chunk`.
	async function beat(currentUrl: string | null): Promise<void> {
		const nowMs = Date.now();
		if (nowMs - lastBeat < HEARTBEAT_MS) return;
		lastBeat = nowMs;
		// Keep the active worker's registry row fresh so a long embed run isn't swept
		// from the live set (best-effort — must not disturb embedding).
		if (run.workerId) {
			await db
				.update(worker)
				.set({ role: 'active', runId, phase: 'embedding', lastSeenAt: new Date() })
				.where(eq(worker.id, run.workerId))
				.catch(() => {});
		}
		const [r] = await db
			.update(syncRun)
			.set({ heartbeatAt: new Date(), currentUrl })
			.where(eq(syncRun.id, runId))
			.returning({ control: syncRun.control });
		control = r?.control ?? 'none';
	}

	await db
		.update(syncRun)
		.set({ status: 'running', startedAt: new Date(), currentPhase: 'embedding' })
		.where(eq(syncRun.id, runId));

	console.log(`embedder: ${embedder.id} (${embedder.dimensions} dims)`);

	// A resource_text row needs work when either:
	//   • status 'ok' but no chunk carries its current sha (never embedded, or the
	//     text changed since — old chunks hold the old sha), OR
	//   • status not 'ok' but chunks still exist (content became non-extractable).
	// Both drop out of the predicate once handled, so the cursor never re-loops a
	// row and a clean re-run selects nothing.
	const needsRebuild = and(
		eq(resourceText.status, 'ok'),
		sql`not exists (select 1 from ${chunk} c where c.resource_id = ${resourceText.resourceId} and c.source_sha = ${resourceText.sha256})`
	);
	const needsClear = and(
		sql`${resourceText.status} <> 'ok'`,
		sql`exists (select 1 from ${chunk} c where c.resource_id = ${resourceText.resourceId})`
	);

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

		const rows = await db
			.select({
				rtId: resourceText.id,
				resourceId: resourceText.resourceId,
				sha256: resourceText.sha256,
				status: resourceText.status,
				text: resourceText.text,
				url: resource.url,
				title: resource.title,
				kind: resource.kind
			})
			.from(resourceText)
			.innerJoin(resource, eq(resource.id, resourceText.resourceId))
			.where(and(gt(resourceText.id, cursor), or(needsRebuild, needsClear)))
			.orderBy(asc(resourceText.id))
			.limit(BATCH);
		if (rows.length === 0) break; // caught up

		for (const r of rows) {
			if (stats.processed >= maxPages) break;
			cursor = r.rtId;
			await beat(r.url);
			if (control === 'cancel') break;

			try {
				if (r.status === 'ok') {
					const n = await rebuildResource(
						{
							resourceId: r.resourceId,
							sha256: r.sha256,
							text: r.text ?? '',
							url: r.url,
							title: r.title,
							kind: r.kind
						},
						embedder
					);
					stats.rebuilt++;
					stats.chunks += n;
				} else {
					// content no longer extractable — drop its now-orphan chunks.
					await db.delete(chunk).where(eq(chunk.resourceId, r.resourceId));
					stats.cleared++;
				}
				stats.processed++;
			} catch (e) {
				stats.errors++;
				const msg = e instanceof Error ? e.message : String(e);
				// Surface per-resource failures on the dashboard's error channel, the
				// same way extract records `extract_error` events.
				await db.insert(crawlEvent).values({
					runId,
					resourceId: r.resourceId,
					url: r.url,
					kind: 'embed_error',
					message: `embed failed: ${msg}`.slice(0, 500)
				});
				console.error(`✗ embed ${r.url}: ${msg}`);
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

	console.log(
		`✓ embed ${runId} ${status}: ${stats.processed} processed ` +
			`(${stats.rebuilt} rebuilt → ${stats.chunks} chunks, ${stats.cleared} cleared), ${stats.errors} errors`
	);
}
