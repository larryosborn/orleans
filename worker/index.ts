// Sync worker entrypoint. Polls sync_run for queued jobs, claims one at a time
// (atomic guard against double-claim), and runs it to completion. Also supports
// a one-shot CLI mode for ops/testing:
//
//   bun run worker/index.ts                       # long-running poll loop
//   bun run worker/index.ts --mode estimate --max 80 --once
//   bun run worker/index.ts --mode crawl          # enqueue + run once, then exit
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { and, asc, eq } from 'drizzle-orm';
import { client, db } from './db';
import { syncRun } from '../src/lib/server/db/schema';
import type { SyncRun } from '../src/lib/server/db/crawl.schema';
import { applyMigrations } from '../src/lib/server/db/migrator';
import { executeRun, executeSync } from './crawl';

const WORKER_ID = `${process.env.HOSTNAME ?? 'worker'}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
const POLL_INTERVAL_MS = 3000;

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

async function pollLoop(): Promise<void> {
	console.log(`sync worker ${WORKER_ID} polling (every ${POLL_INTERVAL_MS}ms)`);
	while (!stopping) {
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
