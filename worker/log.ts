// Worker-scoped helpers over the shared logger (src/lib/server/log.ts). Two things
// every worker logger wants, factored out so no call site re-hand-rolls them:
//   • the `worker:` namespace prefix — so worker namespaces never collide with the
//     app's once it adopts the same logger (#52), and stay grouped in aggregation;
//   • process identity (host/pid) bound on every line.
// Plus a per-run helper binding the SyncRun correlation (workerId/runId/mode/phase)
// in one place, so a run's modules don't each duplicate the same child({...}) and a
// future correlation field is a one-line change here, not shotgun surgery.
import { hostname } from 'node:os';
import { logger, type Logger } from '../src/lib/server/log';
import type { SyncRun } from '../src/lib/server/db/crawl.schema';

const HOST = process.env.HOSTNAME ?? hostname();

/** A namespaced worker logger — `worker:<module>`, bound with host/pid. */
export function workerLogger(module: string): Logger {
	return logger(`worker:${module}`).child({ host: HOST, pid: process.pid });
}

/** Per-run child of a worker logger: binds workerId/runId/mode/phase off the run so
 *  every downstream line self-locates without passing fields per call. */
export function runLogger(module: string, run: SyncRun, phase: string): Logger {
	return workerLogger(module).child({
		workerId: run.workerId ?? undefined,
		runId: run.id,
		mode: run.mode,
		phase
	});
}
