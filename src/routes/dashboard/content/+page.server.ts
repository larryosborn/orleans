import type { PageServerLoad } from './$types';
import * as sync from '$lib/server/sync';

const PAGE_SIZE = 50;

export const load: PageServerLoad = async ({ url }) => {
	const q = url.searchParams.get('q')?.trim() || undefined;
	const kind = url.searchParams.get('kind') || undefined;
	const state = url.searchParams.get('state') || undefined;
	const pageNum = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);

	const { rows, total } = await sync.listResources({
		q,
		kind,
		state,
		limit: PAGE_SIZE,
		offset: (pageNum - 1) * PAGE_SIZE
	});

	return {
		rows,
		total,
		pageNum,
		pageSize: PAGE_SIZE,
		pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
		filters: { q: q ?? '', kind: kind ?? '', state: state ?? '' }
	};
};
