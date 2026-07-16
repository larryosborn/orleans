// Sync content-addressed blobs between the local cache and R2.
//
//   bun run worker/sync-blobs.ts --push    # local  -> R2  (upload what R2 lacks)
//   bun run worker/sync-blobs.ts --pull    # R2     -> local (download what's missing)
//   bun run worker/sync-blobs.ts --both    # reconcile in both directions (default)
//   bun run worker/sync-blobs.ts --both --dry-run
//
// The `blob` table is the manifest of every object that should exist (sha256 ->
// storage_key). Keys are immutable, so syncing is just: for each blob, if the
// destination lacks the key, copy it from the source. No conflicts, ever.
import { db } from './db';
import { blob } from '../src/lib/server/db/schema';
import { makeLocalStorage, makeR2Storage, localDir, type Storage } from './storage';

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
	console.log(
		`${dir.name}: ${dryRun ? 'would copy' : 'copied'} ${copied} object(s), ${human(bytes)}` +
			(missingSrc ? ` — ${missingSrc} missing at source (${dir.src.kind})` : '')
	);
	return { copied, bytes, missingSrc };
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
	console.error(
		'R2 is not configured — set R2_ENDPOINT / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY.'
	);
	process.exit(1);
}

const rows = (
	await db.select({ key: blob.storageKey, contentType: blob.contentType }).from(blob)
).filter(
	(r) => r.key && !r.key.startsWith('local/') // ignore legacy placeholder keys
) as { key: string; contentType: string | null }[];

console.log(
	`manifest: ${rows.length} blob(s) · local=${local.label} · remote=${r2.label}${dryRun ? ' · DRY RUN' : ''}`
);

if (doPush) await copyMissing({ name: 'push (local→R2)', src: local, dst: r2 }, rows, dryRun);
if (doPull) await copyMissing({ name: 'pull (R2→local)', src: r2, dst: local }, rows, dryRun);

process.exit(0);
