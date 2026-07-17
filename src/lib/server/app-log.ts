// App-scoped helpers over the shared logger (./log.ts), mirroring worker/log.ts so
// the SvelteKit app and the sync worker use the logger the same way:
//   • the `app:` namespace prefix — so app namespaces stay grouped in aggregation and
//     never collide with the worker's `worker:` ones;
//   • process identity (host/pid) bound on every line;
//   • optional per-request correlation bound in ONE place, so a future correlation
//     field is a one-line change here, not shotgun surgery across call sites (the same
//     rationale worker/log.ts gives for runLogger).
import { hostname } from 'node:os';
import { logger, type Logger } from './log';

const HOST = process.env.HOSTNAME ?? hostname();

/** A namespaced app logger — `app:<module>`, bound with host/pid and, when a request
 *  id is supplied, correlated to that request. */
export function appLogger(module: string, requestId?: string): Logger {
	const log = logger(`app:${module}`).child({ host: HOST, pid: process.pid });
	return requestId == null ? log : log.child({ requestId });
}
