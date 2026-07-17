// Server-Sent Events stream of the active sync run's live progress. The client
// (dashboard overview) opens an EventSource here and updates the status card as
// events arrive, instead of reloading the page. Gated by auth like the rest of
// the dashboard.
//
// Serverless note: the stream self-closes after MAX_DURATION_MS (well under
// platform limits); EventSource auto-reconnects, so streaming stays continuous.
import type { RequestHandler } from './$types';
import type { SyncRun } from '$lib/server/db/crawl.schema';
import * as sync from '$lib/server/sync';

const POLL_MS = 1500;
const AGG_MS = 4500; // refresh the heavier progress aggregates less often than the run row
const MAX_DURATION_MS = 5 * 60 * 1000;

function serialize(r: SyncRun) {
	return {
		id: r.id,
		mode: r.mode,
		status: r.status,
		discoveryEnabled: r.discoveryEnabled,
		requestsMade: r.requestsMade,
		maxPages: r.maxPages,
		pages: r.pages,
		documents: r.documents,
		newCount: r.newCount,
		changedCount: r.changedCount,
		unchangedCount: r.unchangedCount,
		goneCount: r.goneCount,
		errorCount: r.errorCount,
		bytesDownloaded: r.bytesDownloaded,
		bytesStored: r.bytesStored,
		bytesEstimated: r.bytesEstimated,
		currentUrl: r.currentUrl,
		currentPhase: r.currentPhase,
		workerId: r.workerId,
		requestedAt: r.requestedAt?.getTime() ?? null,
		heartbeatAt: r.heartbeatAt?.getTime() ?? null,
		startedAt: r.startedAt?.getTime() ?? null
	};
}

export const GET: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) return new Response('Unauthorized', { status: 401 });

	const encoder = new TextEncoder();
	let interval: ReturnType<typeof setInterval> | undefined;
	let deadline: ReturnType<typeof setTimeout> | undefined;
	const clear = () => {
		if (interval) clearInterval(interval);
		if (deadline) clearTimeout(deadline);
		interval = deadline = undefined;
	};

	const stream = new ReadableStream({
		async start(controller) {
			const send = (event: string, data: unknown) => {
				try {
					controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
				} catch {
					clear();
				}
			};
			// Reconnection delay hint for EventSource.
			controller.enqueue(encoder.encode('retry: 3000\n\n'));

			// Aggregate progress + the "currently processing" panel are heavier than the
			// run row, so refresh them less often. `processing` is only included in the
			// payload on the ticks it's refreshed; the client keeps its last copy otherwise.
			let lastAgg = 0;
			let agg: sync.SyncProgress | null = null;
			let processing: sync.ProcessingPanel | null = null;
			let workerHealth: sync.WorkerHealth | null = null;
			const tick = async () => {
				try {
					const active = await sync.getActiveRun();
					let fresh = false;
					if (Date.now() - lastAgg >= AGG_MS) {
						lastAgg = Date.now();
						fresh = true;
						[agg, processing, workerHealth] = await Promise.all([
							sync.getSyncProgress(),
							sync.getProcessingRecords(),
							sync.getWorkerHealth()
						]);
					}
					send('progress', {
						run: active ? serialize(active) : null,
						progress: agg,
						processing: fresh ? processing : undefined,
						// Included only on the refreshed ticks; the client keeps its last copy
						// otherwise (same cadence rationale as `processing`).
						workerHealth: fresh ? workerHealth : undefined
					});
				} catch {
					// transient DB error — next tick retries
				}
			};

			await tick();
			interval = setInterval(tick, POLL_MS);
			deadline = setTimeout(() => {
				clear();
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			}, MAX_DURATION_MS);
		},
		cancel() {
			clear();
		}
	});

	request.signal.addEventListener('abort', clear);

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache, no-transform',
			'x-accel-buffering': 'no'
		}
	});
};
