// The environment-agnostic sync-worker CORE.
//
// A single `tick()` is the whole contract: it claims-or-continues the one active
// run, processes ONE bounded batch of work, persists progress to Turso, honors
// control (pause/cancel/discovery), and returns a status — `more` (work remains),
// `idle` (nothing to do right now), or `done` (the run reached a terminal state).
//
// The core deliberately contains **no unbounded loop and no process-lifecycle
// logic**: no `while (true)`, no signal handlers, no sleeps-to-wait. It does one
// bounded unit and returns. The *driver* (worker/driver.ts) owns the loop, the
// idle sleeps, the OS signals, and the periodic maintenance. That split is the
// runtime seam: the same core is pumped by a long-lived local driver today, and
// could be pumped one-tick-per-invocation by a future serverless driver WITHOUT
// any change here (see worker/README.md § Runtime seam).
//
// Single-writer semantics are unchanged — exactly one active run at a time via the
// Turso lease (`claimNext` + heartbeat). And `tick()` advances work idempotently:
// re-running a batch never double-processes, because every processed resource
// reschedules itself (sync) or is skipped as already-captured (crawl), and
// unchanged content produces no new version row (content-addressed sha compare).
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import { db } from './db';
import { syncRun } from '../src/lib/server/db/schema';
import type { SyncRun } from '../src/lib/server/db/crawl.schema';
import { STALE_RUN_MS, TICK_MAX_ITEMS, TICK_TIME_BUDGET_MS } from './config';
import { createCrawlSession, createSyncSession } from './crawl';
import { executeExtract } from './extract';
import { executeEmbed } from './embed';
import type { WorkerIdentity } from './registry';
import { workerLogger } from './log';

// ---------------------------------------------------------------------------
// The session seam — one resumable unit of a run.
//
// A `RunSession` is a claimed run's execution as a series of bounded steps. Each
// mode (crawl/estimate/recrawl, sync, extract, embed) builds one; the core pumps
// its `step()` and never sees mode-specific detail. A session owns its own
// per-run state (frontier, stats, control flags) across steps.
// ---------------------------------------------------------------------------

/** Bounds on a single `step()`: stop at whichever trips first. */
export interface StepBudget {
	/** Max items (fetch attempts / resources) to process this step. */
	maxItems: number;
	/** Soft wall-time budget in ms; checked between items. */
	timeBudgetMs: number;
}

/** What one bounded `step()` produced:
 *  - `more`   — the budget was spent but work remains; pump again.
 *  - `paused` — the run is paused (control=pause); yield and re-check later.
 *  - `done`   — the run reached a terminal state (completed/canceled) and was
 *               finalized; the session is spent. */
export type StepResult = 'more' | 'paused' | 'done';

export interface RunSession {
	readonly run: SyncRun;
	/** Human phase label for logs/registry (`crawling` | `sync` | …). */
	readonly phase: string;
	/** Process one bounded batch of this run's work. Persists its own progress. */
	step(budget: StepBudget): Promise<StepResult>;
}

// ---------------------------------------------------------------------------
// tick — the driver-facing contract.
// ---------------------------------------------------------------------------
export type TickStatus = 'more' | 'idle' | 'done';

export interface TickOptions {
	/** This pumper's identity (for the single-writer lease + registry). */
	identity: WorkerIdentity;
	/** Publish blobs through to R2 (--publish); otherwise local-only. */
	publish: boolean;
	/** Per-tick batch bounds. Defaults to config (TICK_MAX_ITEMS/TICK_TIME_BUDGET_MS). */
	budget?: StepBudget;
}

export interface TickResult {
	status: TickStatus;
	/** The run this tick advanced/owns, if any (null only on a no-work `idle`). */
	runId: string | null;
	mode: string | null;
	phase: string | null;
}

export const DEFAULT_BUDGET: StepBudget = {
	maxItems: TICK_MAX_ITEMS,
	timeBudgetMs: TICK_TIME_BUDGET_MS
};

const log = workerLogger('core');

// The one run this process is currently executing, kept warm across ticks. For the
// crawl/estimate/recrawl modes this holds the in-memory BFS frontier, so a
// long-lived driver continues the same walk step to step. `sync` is DB-resumable
// regardless, so a fresh process (serverless) can re-adopt it via claimNext without
// this cache. Cleared when the run finishes or fails.
let active: RunSession | null = null;

/** Build the right session for a claimed run and run its one-time init. */
async function createSession(run: SyncRun, publish: boolean): Promise<RunSession> {
	switch (run.mode) {
		case 'sync':
			return createSyncSession(run, { publish });
		case 'extract':
			return oneShotSession(run, 'extracting', () => executeExtract(run));
		case 'embed':
			return oneShotSession(run, 'embedding', () => executeEmbed(run));
		default:
			// estimate / crawl / recrawl
			return createCrawlSession(run, { publish });
	}
}

// Adapter for the derivation stages (extract/embed). These already own a bounded
// internal batch loop and finalize themselves, so a single `step()` runs one to
// completion and reports `done`. They are not part of the crawl frontier core, so
// they aren't tick-bounded here — a future refactor could make them step-native
// without touching this seam.
function oneShotSession(run: SyncRun, phase: string, execute: () => Promise<void>): RunSession {
	let ran = false;
	return {
		run,
		phase,
		async step(): Promise<StepResult> {
			if (!ran) {
				ran = true;
				await execute();
			}
			return 'done';
		}
	};
}

/**
 * Claim-or-continue the active run, process ONE bounded batch, and return a
 * status. This is the entire core contract — call it repeatedly to make progress.
 */
export async function tick(opts: TickOptions): Promise<TickResult> {
	const budget = opts.budget ?? DEFAULT_BUDGET;

	// Fresh claim only when we aren't already mid-run. Single-writer lease preserved.
	if (!active) {
		const run = await claimNext(opts.identity);
		if (!run) return { status: 'idle', runId: null, mode: null, phase: null };
		log
			.child({ runId: run.id, mode: run.mode })
			.info({ maxPages: run.maxPages ?? 'default', publish: opts.publish }, 'run started');
		try {
			active = await createSession(run, opts.publish);
		} catch (e) {
			await markFailed(run, e);
			return { status: 'done', runId: run.id, mode: run.mode, phase: null };
		}
	}

	const session = active;
	const { run } = session;
	try {
		const result = await session.step(budget);
		if (result === 'done') {
			active = null;
			return { status: 'done', runId: run.id, mode: run.mode, phase: session.phase };
		}
		if (result === 'paused') {
			// Still ours, just waiting — the driver keeps us active and re-ticks later.
			return { status: 'idle', runId: run.id, mode: run.mode, phase: session.phase };
		}
		return { status: 'more', runId: run.id, mode: run.mode, phase: session.phase };
	} catch (e) {
		active = null;
		await markFailed(run, e);
		return { status: 'done', runId: run.id, mode: run.mode, phase: session.phase };
	}
}

/** Mark a run failed (mirrors the old poll loop's runOne catch). */
async function markFailed(run: SyncRun, e: unknown): Promise<void> {
	const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
	log.child({ runId: run.id, mode: run.mode }).error({ err: e }, 'run failed');
	await db
		.update(syncRun)
		.set({ status: 'failed', finishedAt: new Date(), error: msg.slice(0, 2000) })
		.where(eq(syncRun.id, run.id));
}

// One-time log flag so the "standing by" notice prints once per standby episode.
let standby = false;

/**
 * Atomically claim the oldest queued run; returns it or null.
 *
 * Single-writer guard. Two workers iterating the same frontier double-process
 * every resource — duplicate version rows, double blob writes, and 2× request
 * load on the (politely rate-limited) target site. If another worker already owns
 * a live run (fresh heartbeat), stand down. This process becomes a warm standby:
 * it only starts claiming once that worker dies and its run goes stale (reaped by
 * the driver's reapStaleRuns).
 *
 * PRESERVED verbatim from the old worker/index.ts — the lease is the core's
 * correctness guarantee and must not drift.
 */
export async function claimNext(identity: WorkerIdentity): Promise<SyncRun | null> {
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
			log.info(
				{ activeWorkerId: live.workerId },
				'another worker owns an active run — standing by'
			);
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
		.set({
			status: 'running',
			workerId: identity.id,
			startedAt: new Date(),
			heartbeatAt: new Date()
		})
		.where(and(eq(syncRun.id, queued.id), eq(syncRun.status, 'queued')))
		.returning();
	return claimed[0] ?? null; // null => another worker grabbed it first
}
