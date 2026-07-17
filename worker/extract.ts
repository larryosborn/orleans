// Text extraction — stage 1 of the RAG-chatbot pipeline (#32). Turns the stored
// blobs (normalized HTML pages, raw PDF bytes) into clean, retrievable
// main-content plain text and persists it per resource in `resource_text`, so
// downstream chunking/embedding (#35) and retrieval (#36) consume clean text
// instead of chrome-laden HTML or opaque PDF bytes.
//
// Two swappable seams do the actual work (each independently testable):
//   • HTML → readability-style main content, so repeated site chrome
//     (nav/header/footer/sidebar) is dropped — every page no longer looks alike.
//   • PDF  → the text layer, cleaned of layout noise. Image-only / scanned PDFs
//     (no text layer) are recorded `scanned` and counted — never errored.
//
// Caching is by CONTENT hash: a resource is (re)extracted only when its stored
// `sha256` differs from the sha its `resource_text` row was built from. So a
// re-run over unchanged content does no work; changed content re-extracts.
import { and, asc, eq, gt, isNotNull, sql } from 'drizzle-orm';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { extractText as pdfExtractText, getDocumentProxy } from 'unpdf';
import { db } from './db';
import { blob, crawlEvent, resource, resourceText, syncRun } from '../src/lib/server/db/schema';
import type { ExtractionStatus, SyncRun } from '../src/lib/server/db/crawl.schema';
import { localDir, makeLocalStorage, makeR2Storage } from './storage';
import { refreshActiveWorker } from './registry';

const HEARTBEAT_MS = 2000;
const BATCH = 200; // resources per DB round-trip

export interface Extraction {
	status: ExtractionStatus;
	text: string; // '' unless status = 'ok'
	extractor: string; // seam id, for provenance/debugging
}

// ---------------------------------------------------------------------------
// Text cleanup — normalize whitespace while preserving block/paragraph breaks
// (they help the downstream chunker split on natural boundaries).
// ---------------------------------------------------------------------------
function cleanText(s: string): string {
	return s
		.replace(/\r\n?/g, '\n')
		.replace(/[^\S\n]+/g, ' ') // collapse runs of horizontal whitespace, keep newlines
		.replace(/ *\n */g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/** Does the text carry any actual words? Used to tell "real text" from the empty
 *  / punctuation-only output an image-only (scanned) PDF produces. */
function hasWords(s: string): boolean {
	return /[\p{L}\p{N}]/u.test(s);
}

// ---------------------------------------------------------------------------
// HTML seam — readability-style main-content extraction.
// ---------------------------------------------------------------------------
const CHROME_SELECTORS =
	'script,style,noscript,template,svg,nav,header,footer,aside,form,' +
	'[role=navigation],[role=banner],[role=contentinfo],[role=search]';

export function extractHtmlText(html: string): Extraction {
	const { document } = parseHTML(html);

	// Readability mutates the document, so clone for the fallback first.
	const parsed = new Readability(document.cloneNode(true) as typeof document).parse();
	const main = cleanText(parsed?.textContent ?? '');
	if (hasWords(main)) return { status: 'ok', text: main, extractor: 'html:readability' };

	// Readability found no article (short/atypical pages). Fall back to body text
	// with the big shared chrome elements removed — so two pages still don't share
	// large identical nav/footer blocks, which is the whole point of extraction.
	for (const el of document.querySelectorAll(CHROME_SELECTORS)) el.remove();
	const body = cleanText(document.body?.textContent ?? '');
	if (hasWords(body)) return { status: 'ok', text: body, extractor: 'html:body-fallback' };

	return { status: 'empty', text: '', extractor: 'html:readability' };
}

// ---------------------------------------------------------------------------
// PDF seam — extract the text layer via unpdf (a Bun/serverless-friendly pdf.js
// bundle). A parseable PDF with no words in its text layer is image-only
// (scanned): recorded `scanned`, not errored. A genuinely corrupt/undecodable
// PDF throws and is handled as a per-resource error by the caller.
// ---------------------------------------------------------------------------
export async function extractPdfText(bytes: Uint8Array): Promise<Extraction> {
	// verbosity 0 silences pdf.js info/warn chatter (e.g. "Indexing all PDF objects").
	const proxy = await getDocumentProxy(bytes, { verbosity: 0 });
	const { text } = await pdfExtractText(proxy, { mergePages: true });
	const cleaned = cleanText(text);
	if (!hasWords(cleaned)) return { status: 'scanned', text: '', extractor: 'pdf:unpdf' };
	return { status: 'ok', text: cleaned, extractor: 'pdf:unpdf' };
}

// ---------------------------------------------------------------------------
// Dispatch on the stored blob's content type.
// ---------------------------------------------------------------------------
export async function extractFromBlob(
	contentType: string | null,
	bytes: Uint8Array
): Promise<Extraction> {
	const ct = (contentType ?? '').toLowerCase();
	// PDF first: Office Open XML doc types (…openxmlformats…) contain the substring
	// "xml", so an HTML/xml check must not run ahead of the precise type checks.
	if (ct === 'application/pdf' || ct.endsWith('/pdf')) {
		return extractPdfText(bytes);
	}
	if (ct.includes('html') || ct === 'text/xml' || ct === 'application/xml' || ct.endsWith('+xml')) {
		return extractHtmlText(new TextDecoder().decode(bytes));
	}
	// Office docs (.doc/.docx/.xls/.xlsx), images, etc. — out of scope for now
	// (#40 covers OCR / richer document parsing).
	return { status: 'unsupported', text: '', extractor: `none:${ct || 'unknown'}` };
}

// ---------------------------------------------------------------------------
// Blob read path — reuse the Storage backends. Bytes always live locally; on a
// publishing deployment they may only be in R2, so fall back to it.
// ---------------------------------------------------------------------------
function makeBlobReader(): (storageKey: string) => Promise<Uint8Array | null> {
	const local = makeLocalStorage(localDir());
	const r2 = makeR2Storage(); // null when R2 env is absent
	return async (storageKey) =>
		(await local.getBytes(storageKey)) ?? (r2 ? await r2.getBytes(storageKey) : null);
}

// ---------------------------------------------------------------------------
// The extraction run.
// ---------------------------------------------------------------------------
interface ExtractStats {
	processed: number; // resources whose content we extracted this run
	ok: number;
	empty: number;
	scanned: number;
	unsupported: number;
	missingBlob: number; // stored sha but bytes not found in any backend
	errors: number;
}

function zero(): ExtractStats {
	return { processed: 0, ok: 0, empty: 0, scanned: 0, unsupported: 0, missingBlob: 0, errors: 0 };
}

/** Persist (upsert) the extraction result for a resource, keyed by content sha. */
async function writeResult(
	resourceId: string,
	sha256: string,
	contentType: string | null,
	result: Extraction
): Promise<void> {
	const now = new Date();
	const text = result.status === 'ok' ? result.text : null;
	await db
		.insert(resourceText)
		.values({
			resourceId,
			sha256,
			contentType,
			status: result.status,
			text,
			charCount: text?.length ?? 0,
			extractor: result.extractor,
			createdAt: now,
			updatedAt: now
		})
		.onConflictDoUpdate({
			target: resourceText.resourceId,
			set: {
				sha256,
				contentType,
				status: result.status,
				text,
				charCount: text?.length ?? 0,
				extractor: result.extractor,
				updatedAt: now
			}
		});
}

export async function executeExtract(run: SyncRun): Promise<void> {
	const runId = run.id;
	const maxPages = run.maxPages ?? Infinity; // --max caps processed count (testing)
	const readBlob = makeBlobReader();
	const stats = zero();
	let control: string = run.control;
	let lastBeat = 0;

	// Heartbeat keeps the run alive (so reapStaleRuns doesn't kill it) and reads
	// back the control word. Deliberately does NOT write the syncRun rollup
	// counters — those columns are crawl-specific (pages/new/changed/…); the
	// authoritative extraction census lives in `resource_text.status` (queryable)
	// and per-resource errors in `crawl_event`, so we don't overload them here.
	async function beat(currentUrl: string | null): Promise<void> {
		const nowMs = Date.now();
		if (nowMs - lastBeat < HEARTBEAT_MS) return;
		lastBeat = nowMs;
		// Keep the active worker's registry row fresh so a long extract run isn't
		// swept from the live set (best-effort — must not disturb extraction).
		await refreshActiveWorker(run.workerId, runId, 'extracting');
		const [row] = await db
			.update(syncRun)
			.set({ heartbeatAt: new Date(), currentUrl })
			.where(eq(syncRun.id, runId))
			.returning({ control: syncRun.control });
		control = row?.control ?? 'none';
	}

	await db
		.update(syncRun)
		.set({ status: 'running', startedAt: new Date(), currentPhase: 'extracting' })
		.where(eq(syncRun.id, runId));

	// Cursor walk over resources that still need extraction: a stored body whose
	// current sha has no matching resource_text row (never extracted, or content
	// changed since). Cache hits are excluded by the NOT-EXISTS, so a re-run over
	// unchanged content selects nothing. The id cursor advances monotonically, so
	// a resource that errors (no row written) is simply skipped, never re-looped.
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

		const needsExtract = sql`not exists (
			select 1 from ${resourceText} rt
			where rt.resource_id = ${resource.id} and rt.sha256 = ${resource.sha256}
		)`;
		const batch = await db
			.select({
				id: resource.id,
				url: resource.url,
				sha256: resource.sha256,
				contentType: blob.contentType,
				storageKey: blob.storageKey
			})
			.from(resource)
			.innerJoin(blob, eq(blob.sha256, resource.sha256))
			.where(and(isNotNull(resource.sha256), gt(resource.id, cursor), needsExtract))
			.orderBy(asc(resource.id))
			.limit(BATCH);
		if (batch.length === 0) break; // caught up

		for (const r of batch) {
			if (stats.processed >= maxPages) break;
			cursor = r.id;
			await beat(r.url);
			if (control === 'cancel') break;

			try {
				const bytes = await readBlob(r.storageKey);
				if (!bytes) {
					stats.missingBlob++;
					await logEvent(runId, r.url, r.id, 'blob bytes not found in any backend');
					continue;
				}
				const result = await extractFromBlob(r.contentType, bytes);
				await writeResult(r.id, r.sha256!, r.contentType, result);
				stats.processed++;
				stats[result.status]++;
			} catch (e) {
				stats.errors++;
				const msg = e instanceof Error ? e.message : String(e);
				await logEvent(runId, r.url, r.id, `extract failed: ${msg}`.slice(0, 500));
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
		`✓ extract ${runId} ${status}: ${stats.processed} processed ` +
			`(${stats.ok} ok, ${stats.empty} empty, ${stats.scanned} scanned, ` +
			`${stats.unsupported} unsupported), ${stats.missingBlob} missing-blob, ${stats.errors} errors`
	);
}

async function logEvent(
	runId: string,
	url: string,
	resourceId: string,
	message: string
): Promise<void> {
	await db.insert(crawlEvent).values({ runId, resourceId, url, kind: 'extract_error', message });
}
