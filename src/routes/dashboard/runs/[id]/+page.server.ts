import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import * as sync from '$lib/server/sync';

export const load: PageServerLoad = async ({ params }) => {
	const run = await sync.getRun(params.id);
	if (!run) throw error(404, 'Run not found');
	const [events, eventCounts] = await Promise.all([
		sync.getEvents({ runId: run.id, limit: 200 }),
		sync.getEventCounts(run.id)
	]);
	return { run, events, eventCounts };
};
