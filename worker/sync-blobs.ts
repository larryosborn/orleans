// Sync content-addressed blobs between the local cache and R2.
//
//   bun run worker/sync-blobs.ts --push    # local  -> R2  (promote held blobs)
//   bun run worker/sync-blobs.ts --pull    # R2     -> local (download what's missing)
//   bun run worker/sync-blobs.ts --both    # reconcile in both directions (default)
//   bun run worker/sync-blobs.ts --both --dry-run
//
// The `blob` table is the manifest of every object that should exist (sha256 ->
// storage_key). Keys are immutable, so syncing is just: for each blob, if the
// destination lacks the key, copy it from the source. No conflicts, ever.
//
// R2 is the canonical archive; `blob.r2_synced_at` marks objects confirmed there.
// PUSH is the promotion path: it considers only *held* blobs (r2_synced_at IS
// NULL), uploads what R2 lacks, and stamps r2_synced_at — so a second push right
// after copies nothing. PULL reconciles the local cache from R2.
import { eq, isNull } from 'drizzle-orm';
import { db } from './db';
import { blob } from '../src/lib/server/db/schema';
import { makeLocalStorage, makeR2Storage, localDir, type Storage } from './storage';
import { logger } from '../src/lib/server/log';

const log = logger('sync-blobs');

function human(n: number): string {
	const u = ['B', 'KB', 'MB', 'GB', 'TB'];
	let v = n;
	let i = 0;
	while (v >= 1024 && i < u.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

interface Direction {
	name: string;
	src: Storage;
	dst: Storage;
}

async function copyMissing(
	dir: Direction,
	rows: { key: string; contentType: string | null }[],
	dryRun: boolean
) {
	let copied = 0;
	let bytes = 0;
	let missingSrc = 0;
	for (const { key, contentType } of rows) {
		if (await dir.dst.has(key)) continue;
		const data = await dir.src.getBytes(key);
		if (!data) {
			missingSrc++; // manifest says it exists but the source doesn't have the bytes
			continue;
		}
		if (!dryRun) await dir.dst.put(key, data, contentType ?? undefined);
		copied++;
		bytes += data.byteLength;
	}
	log.info(
		{
			direction: dir.name,
			dryRun,
			copied,
			bytes,
			human: human(bytes),
			missingSrc,
			source: dir.src.kind
		},
		`${dir.name}: ${dryRun ? 'would copy' : 'copied'} ${copied} object(s), ${human(bytes)}`
	);
	return { copied, bytes, missingSrc };
}

/** Promote held blobs (r2_synced_at IS NULL) from local → R2, stamping each once
 *  it is confirmed in R2. Already-confirmed blobs are skipped via the marker, so
 *  a second push right after copies nothing. */
async function pushHeld(local: Storage, r2: Storage, dryRun: boolean) {
	const held = (
		await db
			.select({ sha256: blob.sha256, key: blob.storageKey, contentType: blob.contentType })
			.from(blob)
			.where(isNull(blob.r2SyncedAt))
	).filter((r) => r.key && !r.key.startsWith('local/')); // skip legacy placeholder keys

	let copied = 0;
	let bytes = 0;
	let stamped = 0;
	let missingSrc = 0;
	const now = new Date();
	for (const { sha256, key, contentType } of held) {
		if (await r2.has(key)) {
			// Already in R2 (e.g. pushed before the marker existed) — just confirm it.
			if (!dryRun) await db.update(blob).set({ r2SyncedAt: now }).where(eq(blob.sha256, sha256));
			stamped++;
			continue;
		}
		const data = await local.getBytes(key);
		if (!data) {
			missingSrc++; // held per the manifest but the local bytes are gone
			continue;
		}
		if (!dryRun) {
			await r2.put(key, data, contentType ?? undefined);
			await db.update(blob).set({ r2SyncedAt: now }).where(eq(blob.sha256, sha256));
		}
		copied++;
		stamped++;
		bytes += data.byteLength;
	}
	log.info(
		{
			held: held.length,
			dryRun,
			promoted: copied,
			bytes,
			human: human(bytes),
			stamped,
			missingSrc
		},
		`push (local→R2): ${held.length} held · ${dryRun ? 'would promote' : 'promoted'} ${copied} ` +
			`object(s), ${human(bytes)}${dryRun ? '' : ` · stamped ${stamped}`}`
	);
	return { copied, bytes, stamped, missingSrc };
}

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const doPush =
	args.has('--push') || args.has('--both') || (!args.has('--pull') && !args.has('--push'));
const doPull =
	args.has('--pull') || args.has('--both') || (!args.has('--pull') && !args.has('--push'));

const local = makeLocalStorage(localDir());
const r2 = makeR2Storage();
if (!r2) {
	log.error(
		'R2 is not configured — set R2_ENDPOINT / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY.'
	);
	process.exit(1);
}

const rows = (
	await db.select({ key: blob.storageKey, contentType: blob.contentType }).from(blob)
).filter(
	(r) => r.key && !r.key.startsWith('local/') // ignore legacy placeholder keys
) as { key: string; contentType: string | null }[];

log.info(
	{ blobs: rows.length, local: local.label, remote: r2.label, dryRun },
	`manifest: ${rows.length} blob(s) · local=${local.label} · remote=${r2.label}${dryRun ? ' · DRY RUN' : ''}`
);

// Push is the promotion path (marker-aware); pull reconciles the local cache.
if (doPush) await pushHeld(local, r2, dryRun);
if (doPull) await copyMissing({ name: 'pull (R2→local)', src: r2, dst: local }, rows, dryRun);

process.exit(0);
