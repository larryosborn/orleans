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
// Local backend location
// ---------------------------------------------------------------------------
const DEFAULT_LOCAL_DIR = '.cache/blobs';

export function localDir(): string {
	return process.env.BLOB_DIR ?? DEFAULT_LOCAL_DIR;
}

// ---------------------------------------------------------------------------
// Blob write path (the crawler's view of storage)
// ---------------------------------------------------------------------------
// R2 is the canonical durable archive, but publishing to it is *opt-in*. The
// crawler ALWAYS writes new bytes to the local backend (the dev/staging cache);
// only when publishing is enabled does it ALSO write-through to R2 and report
// the object as synced (which stamps `blob.r2_synced_at`). A default run never
// touches R2, so a dev/experimental crawl can't pollute the canonical archive.
export interface BlobWriter {
	/** True when this run writes through to R2 (prod / `--publish`). */
	readonly publish: boolean;
	readonly label: string;
	/** Store bytes under the content-addressed key. Always writes to the local
	 *  backend; when publishing, also writes-through to R2. Returns the key and
	 *  whether the object is confirmed present in R2 (drives `blob.r2_synced_at`). */
	putIfAbsent(
		sha256: string,
		ext: string,
		bytes: Uint8Array,
		contentType?: string
	): Promise<{ key: string; r2Synced: boolean }>;
	/** Promote an already-stored object to R2 (only when publishing). Returns true
	 *  once the object is confirmed in R2 — so an unpublished blob seen again by a
	 *  publishing run gets stamped rather than left held. */
	ensurePublished(key: string, bytes: Uint8Array, contentType?: string): Promise<boolean>;
}

/** Build the crawler's blob write path. `publish` gates the R2 write-through
 *  ONLY — the local backend is always written. Publishing requires R2 env. */
export function makeBlobWriter(opts: { publish: boolean }): BlobWriter {
	const local = makeLocalStorage(localDir());
	const r2 = opts.publish ? makeR2Storage() : null;
	if (opts.publish && !r2) {
		throw new Error(
			'--publish requires R2_* env vars (R2_ENDPOINT / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY).'
		);
	}
	return {
		publish: opts.publish,
		label: r2
			? `${local.label} + write-through to ${r2.label}`
			: `${local.label} — local-only (unpublished; pass --publish to write through to R2)`,
		async putIfAbsent(sha256, ext, bytes, contentType) {
			const key = await local.putIfAbsent(sha256, ext, bytes, contentType);
			if (!r2) return { key, r2Synced: false };
			await r2.putIfAbsent(sha256, ext, bytes, contentType);
			return { key, r2Synced: true };
		},
		async ensurePublished(key, bytes, contentType) {
			if (!r2) return false;
			if (!(await r2.has(key))) await r2.put(key, bytes, contentType);
			return true;
		}
	};
}
