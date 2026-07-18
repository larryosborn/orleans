// Sync worker entrypoint — now a THIN shell over the runtime seam. It builds this
// process's identity + tick budget, applies pending migrations, then either:
//   • pumps the CORE (worker/core.ts) to completion for a one-shot CLI job, or
//   • hands off to the LOCAL DRIVER (worker/driver.ts) for the long-running loop.
//
// The execution model (the loop, sleeps, signals, maintenance) lives in the
// driver; the bounded batch of crawl work lives in the core. This file only wires
// them together and parses flags. See worker/README.md § Runtime seam.
//
//   bun run worker/index.ts                       # long-running local driver
//   bun run worker/index.ts --publish             # ...writing blobs through to R2
//   bun run worker/index.ts --mode estimate --max 80 --once
//   bun run worker/index.ts --mode crawl          # enqueue + run once, then exit
//
// Publishing is opt-in: without --publish the worker holds blobs in the LOCAL
// backend only (r2_synced_at null); with --publish it writes through to R2 (the
// canonical archive) and stamps r2_synced_at. Prod runs pass --publish.
import { hostname } from 'node:os';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { client, db } from './db';
import { syncRun } from '../src/lib/server/db/schema';
import { applyMigrations } from '../src/lib/server/db/migrator';
import { DEFAULT_BUDGET } from './core';
import { makeLocalDriver, runToCompletion, type DriverContext } from './driver';
import type { WorkerIdentity } from './registry';
import { workerLogger } from './log';

const WORKER_HOST = process.env.HOSTNAME ?? hostname();
const WORKER_ID = `${WORKER_HOST}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
const IDENTITY: WorkerIdentity = { id: WORKER_ID, host: WORKER_HOST, pid: process.pid };

const log = workerLogger('index').child({ workerId: WORKER_ID });

/** Apply pending drizzle migrations (same runner the web app uses). */
async function ensureSchema(): Promise<void> {
	const dir = fileURLToPath(new URL('../drizzle/', import.meta.url));
	const entries = readdirSync(dir)
		.filter((f) => f.endsWith('.sql'))
		.map((name) => ({ name, sql: readFileSync(dir + name, 'utf8') }));
	const ran = await applyMigrations(client, entries);
	if (ran.length) log.info({ migrations: ran }, `applied ${ran.length} migration(s)`);
}

/** Enqueue a single run and pump the core to completion (one-shot CLI). */
async function enqueueAndRunOnce(
	ctx: DriverContext,
	mode: string,
	maxPages?: number
): Promise<void> {
	await db
		.insert(syncRun)
		.values({ mode, maxPages: maxPages ?? null, status: 'queued', requestedBy: 'cli' });
	await runToCompletion(ctx);
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
const ctx: DriverContext = { identity: IDENTITY, publish: args.publish, budget: DEFAULT_BUDGET };

await ensureSchema();
if (args.mode || args.once) {
	await enqueueAndRunOnce(ctx, args.mode ?? 'estimate', args.max);
	process.exit(0);
} else {
	await makeLocalDriver(ctx).run();
	process.exit(0);
}
