// View an archived copy of a resource. Resolves the resource's latest stored
// blob and either redirects to a presigned R2 URL (prod) or streams the local
// cached file (dev). Auth-gated like the rest of the dashboard.
import { error, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { resource, blob } from '$lib/server/db/schema';
import { presignBlob, r2Configured, readLocalBlob } from '$lib/server/blob';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals, setHeaders }) => {
	if (!locals.user) return new Response('Unauthorized', { status: 401 });

	const [res] = await db
		.select({ sha: resource.sha256, url: resource.url })
		.from(resource)
		.where(eq(resource.id, params.id))
		.limit(1);
	if (!res) throw error(404, 'Resource not found');
	if (!res.sha) throw error(404, 'No stored copy — this URL was recorded but never downloaded');

	const [b] = await db
		.select({ key: blob.storageKey, type: blob.contentType })
		.from(blob)
		.where(eq(blob.sha256, res.sha))
		.limit(1);
	if (!b) throw error(404, 'Stored copy not found');

	if (r2Configured()) {
		throw redirect(302, await presignBlob(b.key));
	}

	// Local dev fallback: stream the cached file.
	const body = await readLocalBlob(b.key);
	if (!body) throw error(404, 'Stored copy not found in local cache');
	setHeaders({
		'content-type': b.type || 'application/octet-stream',
		'cache-control': 'private, max-age=60'
	});
	return new Response(body);
};
