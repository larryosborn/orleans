import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import type { SyncRun } from '$lib/server/db/crawl.schema';
import * as sync from '$lib/server/sync';

export const load: PageServerLoad = async () => {
	const [overview, active, recent, lastRun, events, eventCounts, storage, feed] = await Promise.all(
		[
			sync.getOverview(),
			sync.getActiveRun(),
			sync.getRecentRuns(6),
			sync.getLastCompletedRun(),
			sync.getEvents({ limit: 10 }),
			sync.getEventCounts(),
			sync.getStorageByType(),
			sync.getChangeFeed(10)
		]
	);

	// Worker-health hint: a run is queued/running in the DB, but is anything
	// actually processing it? If nothing has claimed a queued run, or a running
	// run's heartbeat has gone stale, the worker probably isn't running.
	const workerAlert = detectWorkerAlert(active);

	return { overview, active, recent, lastRun, events, eventCounts, storage, feed, workerAlert };
};

const STALE_HEARTBEAT_MS = 30_000;
const QUEUE_GRACE_MS = 12_000;

function detectWorkerAlert(active: SyncRun | null): string | null {
	if (!active) return null;
	const now = Date.now();
	if (active.status === 'queued') {
		if (now - active.requestedAt.getTime() > QUEUE_GRACE_MS) {
			return 'This run is queued but no worker has claimed it. Start the worker with `bun run worker`.';
		}
		return null;
	}
	if (active.status === 'running' || active.status === 'paused') {
		const beat = active.heartbeatAt?.getTime();
		if (!beat || now - beat > STALE_HEARTBEAT_MS) {
			const ago = beat ? `${Math.round((now - beat) / 1000)}s ago` : 'never';
			return `The worker hasn't sent a heartbeat (last: ${ago}) — it may have stopped. Check that \`bun run worker\` is running.`;
		}
	}
	return null;
}

const MODES = ['sync', 'estimate', 'crawl', 'recrawl'] as const;
const ACTIONS = ['pause', 'resume', 'cancel'] as const;

export const actions: Actions = {
	enqueue: async ({ request, locals }) => {
		const data = await request.formData();
		const mode = String(data.get('mode') ?? '');
		const maxRaw = data.get('max');
		const maxPages = maxRaw && String(maxRaw).trim() ? Number(maxRaw) : null;
		if (!MODES.includes(mode as (typeof MODES)[number]))
			return fail(400, { error: 'invalid mode' });
		if (maxPages !== null && (!Number.isFinite(maxPages) || maxPages <= 0)) {
			return fail(400, { error: 'invalid max' });
		}

		// Max file size to download, in MB. Blank = download all; 0 = skip all
		// documents (pages-only). Converted to bytes for the worker.
		const docMbRaw = data.get('maxDocMb');
		let maxDocBytes: number | null = null;
		if (docMbRaw != null && String(docMbRaw).trim() !== '') {
			const mb = Number(docMbRaw);
			if (!Number.isFinite(mb) || mb < 0) return fail(400, { error: 'invalid max file size' });
			maxDocBytes = Math.round(mb * 1024 * 1024);
		}

		const id = await sync.enqueueRun(mode as sync.SyncMode, {
			maxPages,
			maxDocBytes,
			userId: locals.user?.id
		});
		return { enqueued: id, mode };
	},

	control: async ({ request }) => {
		const data = await request.formData();
		const runId = String(data.get('runId') ?? '');
		const action = String(data.get('action') ?? '');
		if (!runId || !ACTIONS.includes(action as (typeof ACTIONS)[number])) {
			return fail(400, { error: 'invalid control' });
		}
		await sync.setControl(runId, action as sync.ControlAction);
		return { controlled: action };
	}
};
