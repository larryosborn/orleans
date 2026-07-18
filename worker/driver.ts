// Worker DRIVERS — the environment-specific half of the runtime seam.
//
// The core (worker/core.ts) is a pure `tick()`: one bounded batch, no loop, no
// signals, no sleeps. A *driver* supplies everything env-specific around it:
//   • the loop that pumps `tick()` and reacts to its status,
//   • the idle wait between polls,
//   • OS signal handling / graceful shutdown,
//   • the periodic maintenance (reap stale runs, sweep the worker registry,
//     refresh this worker's standby row, auto-schedule sync runs),
//   • the worker-registry active/standby transitions around a run.
//
// Only the LOCAL driver is implemented here (a long-lived process — `bun run
// worker`). The seam is shaped so other drivers slot in WITHOUT touching the core:
//
//   ┌─────────────────────── the seam ───────────────────────┐
//   │  a driver = { provide identity/publish/budget }         │
//   │            + { loop discipline: when to tick / wait }    │
//   │            + { lifecycle: signals, maintenance cadence } │
//   │  calling only: tick(), runMaintenance(), the registry.   │
//   └─────────────────────────────────────────────────────────┘
//
// A future SERVERLESS driver (Cloudflare/Vercel — NOT built here) would compose
// the very same primitives, but invert the loop: the platform's scheduler is the
// loop, so its handler does `runMaintenance()` + a single `tick()` per invocation
// and returns — `more` schedules an immediate follow-up, `idle` waits for the next
// cron tick, `done` lets it lapse. Because `sync` is DB-resumable (the frontier is
// the `resource` table, and every processed row reschedules itself), one tick per
// invocation across fresh processes still converges — no core change required.
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { db } from './db';
import { syncRun } from '../src/lib/server/db/schema';
import {
	MAINTENANCE_INTERVAL_MS,
	POLL_INTERVAL_MS,
	STALE_RUN_MS,
	SYNC_SCHEDULE_MS
} from './config';
import { deregisterWorker, sweepStaleWorkers, upsertWorker, type WorkerIdentity } from './registry';
import { DEFAULT_BUDGET, tick, type StepBudget } from './core';
import { workerLogger } from './log';

const ACTIVE = ['queued', 'running', 'paused'] as const;

/** What a driver needs to pump the core. The seam's config surface. */
export interface DriverContext {
	identity: WorkerIdentity;
	publish: boolean;
	/** Per-tick batch bounds. Defaults to config. */
	budget?: StepBudget;
}

/** A driver owns the loop that pumps the core. Local today; serverless later. */
export interface Driver {
	run(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Maintenance — env-agnostic housekeeping any driver runs on a cadence. Kept here
// (not in the core) because *when* to run it is a driver/lifecycle decision.
// ---------------------------------------------------------------------------

/** Mark crashed runs (running/paused, heartbeat gone stale) as failed, so a dead
 *  worker doesn't leave an active row blocking claims + the schedule. */
export async function reapStaleRuns(): Promise<void> {
	const log = workerLogger('driver');
	const reaped = await db
		.update(syncRun)
		.set({
			status: 'failed',
			finishedAt: new Date(),
			error: 'worker heartbeat timed out (reaped)'
		})
		.where(
			and(
				inArray(syncRun.status, ['running', 'paused']),
				lt(syncRun.heartbeatAt, new Date(Date.now() - STALE_RUN_MS))
			)
		)
		.returning({ id: syncRun.id });
	if (reaped.length)
		log.warn({ reaped: reaped.map((r) => r.id) }, `reaped ${reaped.length} stale run(s)`);
}

/** Auto-schedule: enqueue a `sync` run when enabled, idle, and one is due. */
export async function maybeScheduleSync(): Promise<void> {
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
	workerLogger('driver').info('scheduled sync enqueued');
}

/** One maintenance pass. `idle` (no run in flight) also refreshes this worker's
 *  standby registry row — skipped mid-run so it never clobbers the active role the
 *  run's heartbeat is keeping fresh. */
export async function runMaintenance(identity: WorkerIdentity, idle: boolean): Promise<void> {
	await reapStaleRuns();
	await sweepStaleWorkers(STALE_RUN_MS);
	if (idle) await upsertWorker(identity, 'standby', null, null);
	await maybeScheduleSync();
}

// ---------------------------------------------------------------------------
// Local driver — the long-lived process. Behaves exactly as the old pollLoop.
// ---------------------------------------------------------------------------
export function makeLocalDriver(ctx: DriverContext): Driver {
	return { run: () => runLocalDriver(ctx) };
}

async function runLocalDriver(ctx: DriverContext): Promise<void> {
	const { identity, publish } = ctx;
	const budget = ctx.budget ?? DEFAULT_BUDGET;
	const log = workerLogger('driver').child({ workerId: identity.id });

	let stopping = false;
	const onSignal = (sig: string) => {
		stopping = true;
		log.info(`${sig} received — shutting down after current run`);
	};
	process.on('SIGINT', () => onSignal('SIGINT'));
	process.on('SIGTERM', () => onSignal('SIGTERM'));

	log.info(
		{
			pollIntervalMs: POLL_INTERVAL_MS,
			tickBudget: budget,
			autoSyncMinutes: SYNC_SCHEDULE_MS > 0 ? SYNC_SCHEDULE_MS / 60_000 : null,
			publish
		},
		'sync worker polling'
	);

	// The run this driver is currently steering (spans many ticks), so we stamp the
	// registry active once on claim and standby once on finish — the run's own
	// heartbeat keeps it active in between.
	let currentRunId: string | null = null;
	let lastMaintenance = 0;

	try {
		for (;;) {
			const idle = currentRunId === null;
			if (Date.now() - lastMaintenance > MAINTENANCE_INTERVAL_MS) {
				lastMaintenance = Date.now();
				await runMaintenance(identity, idle);
			}

			const r = await tick({ identity, publish, budget });

			// A newly-started run: flip this worker to active (its heartbeat keeps it so).
			if (r.runId && r.runId !== currentRunId) {
				currentRunId = r.runId;
				await upsertWorker(identity, 'active', r.runId, r.phase);
			}

			if (r.status === 'more') continue; // keep pumping — also finishes the run under stop
			if (r.status === 'done') {
				currentRunId = null;
				await upsertWorker(identity, 'standby', null, null);
				if (stopping) break;
				continue; // immediately try the next queued run (matches the old loop)
			}
			// idle: either no work, or the owned run is paused.
			if (!r.runId && currentRunId) {
				currentRunId = null;
				await upsertWorker(identity, 'standby', null, null);
			}
			if (stopping) break; // stop now (a paused run is left to be resumed/reaped)
			await Bun.sleep(POLL_INTERVAL_MS);
		}
	} finally {
		await deregisterWorker(identity.id);
		log.info('stopped');
	}
}

// ---------------------------------------------------------------------------
// One-shot pump — the CLI (`--mode X --once`). Pumps `tick()` to drive EXACTLY
// ONE run to completion, then returns — matching the old enqueueAndRunOnce, which
// claimed+ran a single row and exited. No loop-forever, no signals, no
// maintenance. It does NOT drain other queued runs (a scheduler/dashboard row is
// left for the long-running driver).
// ---------------------------------------------------------------------------
export async function runSingleJob(ctx: DriverContext): Promise<void> {
	const { identity, publish } = ctx;
	const budget = ctx.budget ?? DEFAULT_BUDGET;
	for (;;) {
		const r = await tick({ identity, publish, budget });
		// `done` = the one claimed run finished → exit (don't claim the next).
		// `idle` = nothing claimable (e.g. another worker holds the single-writer
		// lease) → exit rather than hot-spin. Only `more` keeps pumping.
		if (r.status === 'done' || r.status === 'idle') return;
	}
}
