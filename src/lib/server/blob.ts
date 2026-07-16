// Resolve an archived blob for viewing from the dashboard. In production the
// bytes live in R2, so we presign a short-lived GET URL (aws4fetch works on
// Node, Vercel, and Cloudflare Workers). In local dev without R2 we read the
// file straight from the on-disk cache (BLOB_DIR).
import { AwsClient } from 'aws4fetch';
import {
	R2_ENDPOINT,
	R2_BUCKET,
	R2_ACCESS_KEY_ID,
	R2_SECRET_ACCESS_KEY,
	BLOB_DIR
} from '$app/env/private';

export function r2Configured(): boolean {
	return Boolean(R2_ENDPOINT && R2_BUCKET && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY);
}

let client: AwsClient | undefined;
function getClient(): AwsClient {
	if (!client) {
		// Callers gate on r2Configured(), so these are present here.
		client = new AwsClient({
			accessKeyId: R2_ACCESS_KEY_ID!,
			secretAccessKey: R2_SECRET_ACCESS_KEY!,
			service: 's3',
			region: 'auto'
		});
	}
	return client;
}

/** Presigned GET URL for an R2 object key (storage_key), valid for a short time. */
export async function presignBlob(storageKey: string, expiresSeconds = 300): Promise<string> {
	// storage_key is `blobs/ab/cd/<sha><ext>` — all URL-safe, keep the slashes.
	const url = new URL(`${R2_ENDPOINT!.replace(/\/$/, '')}/${R2_BUCKET}/${storageKey}`);
	url.searchParams.set('X-Amz-Expires', String(expiresSeconds));
	const signed = await getClient().sign(url.toString(), {
		method: 'GET',
		aws: { signQuery: true }
	});
	return signed.url;
}

/** Read a blob from the local cache dir (dev fallback when R2 isn't configured). */
export async function readLocalBlob(storageKey: string): Promise<ArrayBuffer | null> {
	try {
		const { readFile } = await import('node:fs/promises');
		const { join, resolve } = await import('node:path');
		const dir = resolve(BLOB_DIR || '.cache/blobs');
		const buf = await readFile(join(dir, storageKey));
		return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
	} catch {
		return null;
	}
}
