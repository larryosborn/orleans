// Sync worker entrypoint. Polls sync_run for queued jobs, claims one at a time
// (atomic guard against double-claim), and runs it to completion. Also supports
// a one-shot CLI mode for ops/testing:
//
//   bun run worker/index.ts                       # long-running poll loop
//   bun run worker/index.ts --mode estimate --max 80 --once
//   bun run worker/index.ts --mode crawl          # enqueue + run once, then exit
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { and, asc, desc, eq, inArray, lt } from 'drizzle-orm';
import { client, db } from './db';
import { syncRun } from '../src/lib/server/db/schema';
import type { SyncRun } from '../src/lib/server/db/crawl.schema';
import { applyMigrations } from '../src/lib/server/db/migrator';
import { SYNC_SCHEDULE_MS, STALE_RUN_MS } from './config';
import { executeRun, executeSync } from './crawl';

const WORKER_ID = `${process.env.HOSTNAME ?? 'worker'}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
const POLL_INTERVAL_MS = 3000;
const MAINTENANCE_INTERVAL_MS = 30_000;
const ACTIVE = ['queued', 'running', 'paused'] as const;

let stopping = false;
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

async function runOne(run: SyncRun): Promise<void> {
	console.log(`▶ run ${run.id} mode=${run.mode} max=${run.maxPages ?? 'default'}`);
	try {
		if (run.mode === 'sync') await executeSync(run);
		else await executeRun(run);
		const [done] = await db.select().from(syncRun).where(eq(syncRun.id, run.id));
		console.log(
			`✓ run ${run.id} ${done?.status}: ${done?.pages} pages, ${done?.documents} docs, ` +
				`${done?.newCount} new / ${done?.changedCount} changed, ${done?.errorCount} errors`
		);
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

async function pollLoop(): Promise<void> {
	const sched = SYNC_SCHEDULE_MS > 0 ? `; auto-sync every ${SYNC_SCHEDULE_MS / 60_000}m` : '';
	console.log(`sync worker ${WORKER_ID} polling (every ${POLL_INTERVAL_MS}ms${sched})`);
	let lastMaintenance = 0;
	while (!stopping) {
		if (Date.now() - lastMaintenance > MAINTENANCE_INTERVAL_MS) {
			lastMaintenance = Date.now();
			await reapStaleRuns();
			await maybeScheduleSync();
		}
		const run = await claimNext();
		if (run) await runOne(run);
		else await Bun.sleep(POLL_INTERVAL_MS);
	}
	console.log('stopped.');
}

async function enqueueAndRunOnce(mode: string, maxPages?: number): Promise<void> {
	const [run] = await db
		.insert(syncRun)
		.values({ mode, maxPages: maxPages ?? null, status: 'queued', requestedBy: 'cli' })
		.returning();
	const claimed = await claimNext(); // claims the row we just made
	await runOne(claimed ?? run);
}

function parseArgs(argv: string[]): { mode?: string; max?: number; once: boolean } {
	const out: { mode?: string; max?: number; once: boolean } = { once: false };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--mode') out.mode = argv[++i];
		else if (argv[i] === '--max') out.max = Number(argv[++i]);
		else if (argv[i] === '--once') out.once = true;
	}
	return out;
}

const args = parseArgs(process.argv.slice(2));
await ensureSchema();
if (args.mode || args.once) {
	await enqueueAndRunOnce(args.mode ?? 'estimate', args.max);
	process.exit(0);
} else {
	await pollLoop();
	process.exit(0);
}
