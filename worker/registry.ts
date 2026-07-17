// Worker-process registry helpers, shared by the poll loop (worker/index.ts) and
// the per-mode heartbeats (crawl / extract / embed). Centralizing the row's shape
// and the best-effort write policy here means adding a field or changing the
// failure handling is a one-file edit, not four. Every write is best-effort: a
// registry failure must never disturb an in-flight run.
import { eq, lt } from 'drizzle-orm';
import { db } from './db';
import { worker } from '../src/lib/server/db/schema';
import { workerLogger } from './log';

const log = workerLogger('registry');

export type WorkerRole = 'active' | 'standby';

export interface WorkerIdentity {
	id: string;
	host: string;
	pid: number;
}

/** Upsert this process's registry row (identity + role + last-seen). The insert
 *  path stamps host/pid + started-at; the update path refreshes role/run/phase and
 *  last-seen. Called on the maintenance tick (standby refresh) and on each
 *  claim/finish transition. */
export async function upsertWorker(
	identity: WorkerIdentity,
	role: WorkerRole,
	runId: string | null,
	phase: string | null
): Promise<void> {
	try {
		const now = new Date();
		await db
			.insert(worker)
			.values({
				id: identity.id,
				host: identity.host,
				pid: identity.pid,
				role,
				runId,
				phase,
				lastSeenAt: now
			})
			.onConflictDoUpdate({ target: worker.id, set: { role, runId, phase, lastSeenAt: now } });
	} catch (e) {
		// Best-effort: a registry write must never disturb an in-flight run.
		log.warn({ err: e, workerId: identity.id, role }, 'worker registry upsert failed');
	}
}

/** Refresh the active worker's row from a heartbeat, so a long run never lets its
 *  last-seen go stale and get swept by another worker. No-op without a worker id
 *  (e.g. an unclaimed CLI run). Shared by every mode's heartbeat. */
export async function refreshActiveWorker(
	workerId: string | null,
	runId: string,
	phase: string
): Promise<void> {
	if (!workerId) return;
	await db
		.update(worker)
		.set({ role: 'active', runId, phase, lastSeenAt: new Date() })
		.where(eq(worker.id, workerId))
		.catch(() => {});
}

/** Drop registry rows whose last-seen is older than the stale window — an
 *  exited/killed worker with no graceful self-removal leaves the live set here.
 *  Callers pass STALE_RUN_MS so a dead worker and its abandoned run age out
 *  together (see reapStaleRuns). */
export async function sweepStaleWorkers(olderThanMs: number): Promise<void> {
	const swept = await db
		.delete(worker)
		.where(lt(worker.lastSeenAt, new Date(Date.now() - olderThanMs)))
		.returning({ id: worker.id });
	if (swept.length)
		log.warn(
			{ swept: swept.map((w) => w.id) },
			`swept ${swept.length} stale worker registration(s)`
		);
}

/** Best-effort self-removal so a graceful shutdown leaves the live set promptly
 *  (a hard kill is handled by sweepStaleWorkers instead). */
export async function deregisterWorker(id: string): Promise<void> {
	try {
		await db.delete(worker).where(eq(worker.id, id));
	} catch {
		/* best-effort — the sweep drops it within the stale window regardless */
	}
}
