import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import * as sync from '$lib/server/sync';

export const load: PageServerLoad = async () => {
	const [
		overview,
		active,
		recent,
		lastRun,
		events,
		eventCounts,
		storage,
		storageHealth,
		feed,
		progress,
		processing
	] = await Promise.all([
		sync.getOverview(),
		sync.getActiveRun(),
		sync.getRecentRuns(6),
		sync.getLastCompletedRun(),
		sync.getEvents({ limit: 10 }),
		sync.getEventCounts(),
		sync.getStorageByType(),
		sync.getStorageHealth(),
		sync.getChangeFeed(10),
		sync.getSyncProgress(),
		sync.getProcessingRecords()
	]);

	// The worker-health hint (is anything actually processing this run?) is derived
	// on the client from the live run so it clears the moment a worker starts
	// heartbeating — a load-time snapshot would go stale. See +page.svelte.
	return {
		overview,
		active,
		recent,
		lastRun,
		events,
		eventCounts,
		storage,
		storageHealth,
		feed,
		progress,
		processing
	};
};

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
	},

	discovery: async ({ request }) => {
		const data = await request.formData();
		const runId = String(data.get('runId') ?? '');
		// Explicit target state so a rapid double-submit is idempotent (never a toggle
		// race). 'on' | 'off'; anything else is rejected.
		const enabled = String(data.get('enabled') ?? '');
		if (!runId || (enabled !== 'on' && enabled !== 'off')) {
			return fail(400, { error: 'invalid discovery toggle' });
		}
		await sync.setDiscovery(runId, enabled === 'on');
		return { discovery: enabled };
	}
};
