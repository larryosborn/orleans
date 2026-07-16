import type { PageServerLoad } from './$types';
import * as sync from '$lib/server/sync';

export const load: PageServerLoad = async () => {
	return { runs: await sync.getRecentRuns(50) };
};
