// Content-addressed blob storage with two interchangeable backends:
//
//   • local  — a filesystem directory (dev/testing; no egress cost)
//   • r2     — Cloudflare R2 (S3-compatible; remote persistence)
//
// Objects are keyed by sha256, so content is immutable and identical bytes
// dedupe to one object. Because keys never change meaning, moving objects
// between backends is a plain copy-what's-missing — see sync-blobs.ts.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { S3Client } from 'bun';

export interface Storage {
	readonly kind: 'local' | 'r2';
	readonly label: string;
	/** Write bytes at an exact key (unconditional). */
	put(key: string, bytes: Uint8Array, contentType?: string): Promise<void>;
	/** Write under the content-addressed key only if absent; returns the key. */
	putIfAbsent(
		sha256: string,
		ext: string,
		bytes: Uint8Array,
		contentType?: string
	): Promise<string>;
	has(key: string): Promise<boolean>;
	getBytes(key: string): Promise<Uint8Array | null>;
	/** A URL/path to view the object (presigned for R2, file:// for local). */
	locate(key: string, expiresInSeconds?: number): string;
}

/** Content-addressed key: blobs/ab/cd/<full-sha><ext> (fanned out by prefix). */
export function blobKey(sha256: string, ext: string): string {
	return `blobs/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}${ext}`;
}

// ---------------------------------------------------------------------------
// Local filesystem backend
// ---------------------------------------------------------------------------
export function makeLocalStorage(dir: string): Storage {
	const root = resolve(dir);
	return {
		kind: 'local',
		label: `local (${root})`,
		async put(key, bytes) {
			const path = join(root, key);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, bytes);
		},
		async putIfAbsent(sha256, ext, bytes) {
			const key = blobKey(sha256, ext);
			if (!(await this.has(key))) await this.put(key, bytes);
			return key;
		},
		async has(key) {
			try {
				await stat(join(root, key));
				return true;
			} catch {
				return false;
			}
		},
		async getBytes(key) {
			try {
				return new Uint8Array(await readFile(join(root, key)));
			} catch {
				return null;
			}
		},
		locate(key) {
			return `file://${join(root, key)}`;
		}
	};
}

// ---------------------------------------------------------------------------
// Cloudflare R2 backend (S3-compatible, via Bun's native S3 client)
// ---------------------------------------------------------------------------
export function makeR2Storage(): Storage | null {
	const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_ENDPOINT } = process.env;
	if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET || !R2_ENDPOINT) return null;

	const s3 = new S3Client({
		accessKeyId: R2_ACCESS_KEY_ID,
		secretAccessKey: R2_SECRET_ACCESS_KEY,
		bucket: R2_BUCKET,
		endpoint: R2_ENDPOINT
	});

	return {
		kind: 'r2',
		label: `R2 (${R2_BUCKET})`,
		async put(key, bytes, contentType) {
			await s3.write(key, bytes, contentType ? { type: contentType } : undefined);
		},
		async putIfAbsent(sha256, ext, bytes, contentType) {
			const key = blobKey(sha256, ext);
			if (!(await s3.exists(key))) await this.put(key, bytes, contentType);
			return key;
		},
		has: (key) => s3.exists(key),
		async getBytes(key) {
			const f = s3.file(key);
			if (!(await f.exists())) return null;
			return new Uint8Array(await f.arrayBuffer());
		},
		locate: (key, expiresInSeconds = 3600) => s3.presign(key, { expiresIn: expiresInSeconds })
	};
}

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------
const DEFAULT_LOCAL_DIR = '.cache/blobs';

export function localDir(): string {
	return process.env.BLOB_DIR ?? DEFAULT_LOCAL_DIR;
}

/** Which backend the crawler writes to. `BLOB_STORE=r2|local|auto` (default auto:
 *  R2 when its env is set, else the local cache dir `BLOB_DIR` / .cache/blobs). */
let active: Storage | undefined;
export function getStorage(): Storage {
	if (active) return active;
	const mode = (process.env.BLOB_STORE ?? 'auto').toLowerCase();
	const r2 = makeR2Storage();
	if (mode === 'r2') {
		if (!r2) throw new Error('BLOB_STORE=r2 but R2_* env vars are not set.');
		active = r2;
	} else if (mode === 'local') {
		active = makeLocalStorage(localDir());
	} else {
		active = r2 ?? makeLocalStorage(localDir());
	}
	return active;
}
