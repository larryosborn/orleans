// Sync worker entrypoint. Polls sync_run for queued jobs, claims one at a time
// (atomic guard against double-claim), and runs it to completion. Also supports
// a one-shot CLI mode for ops/testing:
//
//   bun run worker/index.ts                       # long-running poll loop
//   bun run worker/index.ts --publish             # ...writing blobs through to R2
//   bun run worker/index.ts --mode estimate --max 80 --once
//   bun run worker/index.ts --mode crawl          # enqueue + run once, then exit
//
// Publishing is opt-in: without --publish the worker holds blobs in the LOCAL
// backend only (r2_synced_at null); with --publish it writes through to R2 (the
// canonical archive) and stamps r2_synced_at. Prod runs pass --publish.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { and, asc, desc, eq, gt, inArray, lt } from 'drizzle-orm';
import { client, db } from './db';
import { syncRun } from '../src/lib/server/db/schema';
import type { SyncRun } from '../src/lib/server/db/crawl.schema';
import { applyMigrations } from '../src/lib/server/db/migrator';
import { SYNC_SCHEDULE_MS, STALE_RUN_MS } from './config';
import { executeRun, executeSync } from './crawl';
import { executeExtract } from './extract';

const WORKER_ID = `${process.env.HOSTNAME ?? 'worker'}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
const POLL_INTERVAL_MS = 3000;
const MAINTENANCE_INTERVAL_MS = 30_000;
const ACTIVE = ['queued', 'running', 'paused'] as const;

let stopping = false;
let standby = false;
process.on(
	'SIGINT',
	() => ((stopping = true), console.log('\nshutting down after current job...'))
);
process.on('SIGTERM', () => (stopping = true));

/** Apply pending drizzle migrations (same runner the web app uses). */
async function ensureSchema(): Promise<void> {
	const dir = fileURLToPath(new URL('../drizzle/', import.meta.url));
	const entries = readdirSync(dir)
		.filter((f) => f.endsWith('.sql'))
		.map((name) => ({ name, sql: readFileSync(dir + name, 'utf8') }));
	const ran = await applyMigrations(client, entries);
	if (ran.length) console.log(`applied ${ran.length} migration(s): ${ran.join(', ')}`);
}

/** Atomically claim the oldest queued run; returns it or null. */
async function claimNext(): Promise<SyncRun | null> {
	// Single-writer guard. Two workers iterating the same frontier double-process
	// every resource — duplicate version rows, double blob writes, and 2× request
	// load on the (politely rate-limited) target site. If another worker already
	// owns a live run (fresh heartbeat), stand down. This process becomes a warm
	// standby: it only starts claiming once that worker dies and its run goes
	// stale (reaped by reapStaleRuns).
	const [live] = await db
		.select({ id: syncRun.id, workerId: syncRun.workerId })
		.from(syncRun)
		.where(
			and(
				inArray(syncRun.status, ['running', 'paused']),
				gt(syncRun.heartbeatAt, new Date(Date.now() - STALE_RUN_MS))
			)
		)
		.limit(1);
	if (live) {
		if (!standby) {
			console.log(`another worker (${live.workerId}) owns an active run — standing by`);
			standby = true;
		}
		return null;
	}
	standby = false;

	const [queued] = await db
		.select()
		.from(syncRun)
		.where(eq(syncRun.status, 'queued'))
		.orderBy(asc(syncRun.requestedAt))
		.limit(1);
	if (!queued) return null;

	const claimed = await db
		.update(syncRun)
		.set({ status: 'running', workerId: WORKER_ID, startedAt: new Date(), heartbeatAt: new Date() })
		.where(and(eq(syncRun.id, queued.id), eq(syncRun.status, 'queued')))
		.returning();
	return claimed[0] ?? null; // null => another worker grabbed it first
}

async function runOne(run: SyncRun, publish: boolean): Promise<void> {
	console.log(`▶ run ${run.id} mode=${run.mode} max=${run.maxPages ?? 'default'}`);
	try {
		if (run.mode === 'sync') await executeSync(run, { publish });
		else if (run.mode === 'extract') await executeExtract(run);
		else await executeRun(run, { publish });
		const [done] = await db.select().from(syncRun).where(eq(syncRun.id, run.id));
		// extract logs its own summary (counts are extraction-specific, not crawl rollups).
		if (run.mode !== 'extract') {
			console.log(
				`✓ run ${run.id} ${done?.status}: ${done?.pages} pages, ${done?.documents} docs, ` +
					`${done?.newCount} new / ${done?.changedCount} changed, ${done?.errorCount} errors`
			);
		}
	} catch (e) {
		const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
		console.error(`✗ run ${run.id} failed:`, msg);
		await db
			.update(syncRun)
			.set({ status: 'failed', finishedAt: new Date(), error: msg.slice(0, 2000) })
			.where(eq(syncRun.id, run.id));
	}
}

/** Mark crashed runs (running/paused, heartbeat gone stale) as failed, so a dead
 *  worker doesn't leave an active row blocking claims + the schedule. */
async function reapStaleRuns(): Promise<void> {
	const reaped = await db
		.update(syncRun)
		.set({ status: 'failed', finishedAt: new Date(), error: 'worker heartbeat timed out (reaped)' })
		.where(
			and(
				inArray(syncRun.status, ['running', 'paused']),
				lt(syncRun.heartbeatAt, new Date(Date.now() - STALE_RUN_MS))
			)
		)
		.returning({ id: syncRun.id });
	if (reaped.length) console.log(`reaped ${reaped.length} stale run(s)`);
}

/** Auto-schedule: enqueue a `sync` run when enabled, idle, and one is due. */
async function maybeScheduleSync(): Promise<void> {
	if (SYNC_SCHEDULE_MS <= 0) return;
	const [active] = await db
		.select({ id: syncRun.id })
		.from(syncRun)
		.where(inArray(syncRun.status, [...ACTIVE]))
		.limit(1);
	if (active) return; // don't stack runs
	const [last] = await db
		.select({ at: syncRun.requestedAt })
		.from(syncRun)
		.where(eq(syncRun.mode, 'sync'))
		.orderBy(desc(syncRun.requestedAt))
		.limit(1);
	const dueAt = last ? last.at.getTime() + SYNC_SCHEDULE_MS : 0;
	if (Date.now() < dueAt) return;
	await db.insert(syncRun).values({ mode: 'sync', status: 'queued', requestedBy: 'scheduler' });
	console.log('scheduled sync enqueued');
}

async function pollLoop(publish: boolean): Promise<void> {
	const sched = SYNC_SCHEDULE_MS > 0 ? `; auto-sync every ${SYNC_SCHEDULE_MS / 60_000}m` : '';
	const pub = publish ? '; publishing to R2' : '; local-only (unpublished)';
	console.log(`sync worker ${WORKER_ID} polling (every ${POLL_INTERVAL_MS}ms${sched}${pub})`);
	let lastMaintenance = 0;
	while (!stopping) {
		if (Date.now() - lastMaintenance > MAINTENANCE_INTERVAL_MS) {
			lastMaintenance = Date.now();
			await reapStaleRuns();
			await maybeScheduleSync();
		}
		const run = await claimNext();
		if (run) await runOne(run, publish);
		else await Bun.sleep(POLL_INTERVAL_MS);
	}
	console.log('stopped.');
}

async function enqueueAndRunOnce(mode: string, publish: boolean, maxPages?: number): Promise<void> {
	const [run] = await db
		.insert(syncRun)
		.values({ mode, maxPages: maxPages ?? null, status: 'queued', requestedBy: 'cli' })
		.returning();
	const claimed = await claimNext(); // claims the row we just made
	await runOne(claimed ?? run, publish);
}

function parseArgs(argv: string[]): {
	mode?: string;
	max?: number;
	once: boolean;
	publish: boolean;
} {
	const out: { mode?: string; max?: number; once: boolean; publish: boolean } = {
		once: false,
		publish: false
	};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--mode') out.mode = argv[++i];
		else if (argv[i] === '--max') out.max = Number(argv[++i]);
		else if (argv[i] === '--once') out.once = true;
		else if (argv[i] === '--publish') out.publish = true;
	}
	return out;
}

const args = parseArgs(process.argv.slice(2));
await ensureSchema();
if (args.mode || args.once) {
	await enqueueAndRunOnce(args.mode ?? 'estimate', args.publish, args.max);
	process.exit(0);
} else {
	await pollLoop(args.publish);
	process.exit(0);
}
