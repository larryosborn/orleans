// Shared structured logger (pino), server-side only. One logger, used by BOTH the
// standalone Bun sync worker (worker/*) and — as of a follow-up (#52) — the
// SvelteKit app. Import it, name a namespace, log with a level:
//
//     import { logger } from '$lib/server/log'; // or '../src/lib/server/log' from worker/
//     const log = logger('crawl');
//     log.info('run started');
//     log.child({ runId, mode }).warn('slow response');
//
// Output shape:
//   • prod  — one JSON object per line to stdout (level, time, ns, msg + bound
//     context). Machine-parseable for aggregation / alerting / diagnostics.
//   • dev   — pretty-printed, one line each, with the namespace colored a STABLE
//     per-namespace color (same idea as the `debug` npm module: hash the namespace
//     to a fixed color) so modules are distinguishable at a glance.
//
// Level threshold comes from LOG_LEVEL (default 'info'); below-threshold calls are
// dropped. Pretty vs JSON is chosen by LOG_PRETTY (explicit), else NODE_ENV.
//
// Correlation is done with child loggers, not per-call fields: bind workerId (+
// host/pid) once on a base logger, add runId/mode/phase on a per-run child, and
// every line downstream self-locates. See worker/ for how the sync worker binds
// these.
//
// Bun note: pino-pretty is attached as an in-process stream (single thread), NOT
// via pino.transport() — pino's worker-thread transports are unreliable under Bun,
// and a synchronous/single-thread destination sidesteps that entirely.
import pino from 'pino';
import pretty from 'pino-pretty';

/** Field key carrying a logger's namespace (e.g. "worker:crawl"). */
const NS_KEY = 'ns';

// ---------------------------------------------------------------------------
// Stable per-namespace color (dev pretty only). Mirrors the `debug` module:
// hash the namespace to an index into a fixed 256-color palette, so a given
// namespace always renders in the same, distinct color.
// ---------------------------------------------------------------------------
// The `debug` module's curated 256-color set (skips low-contrast colors).
const NS_COLORS = [
	20, 21, 26, 27, 32, 33, 38, 39, 40, 41, 42, 43, 44, 45, 56, 57, 62, 63, 68, 69, 74, 75, 76, 77,
	78, 79, 80, 81, 92, 93, 98, 99, 112, 113, 128, 129, 134, 135, 148, 149, 160, 161, 162, 163, 164,
	165, 166, 167, 168, 169, 170, 171, 172, 173, 178, 179, 184, 185, 196, 197, 198, 199, 200, 201,
	202, 203, 204, 205, 206, 207, 208, 209, 214, 215, 220, 221
];

/** Deterministic hash → palette index (the `debug` module's djb2-ish variant). */
function colorFor(namespace: string): number {
	let hash = 0;
	for (let i = 0; i < namespace.length; i++) {
		hash = (hash << 5) - hash + namespace.charCodeAt(i);
		hash |= 0; // keep it a 32-bit int
	}
	return NS_COLORS[Math.abs(hash) % NS_COLORS.length];
}

/** Wrap a namespace in its stable 256-color ANSI code (dev only). */
function paintNamespace(namespace: string): string {
	return `\x1b[38;5;${colorFor(namespace)}m${namespace}\x1b[0m`;
}

// ---------------------------------------------------------------------------
// Configuration from the environment.
// ---------------------------------------------------------------------------
const LEVEL = process.env.LOG_LEVEL?.toLowerCase() || 'info';

/** Pretty output when LOG_PRETTY is set truthy; otherwise whenever we're not in
 *  production. LOG_PRETTY=false/0 forces JSON even in dev (e.g. to eyeball prod
 *  output locally). */
function usePretty(): boolean {
	const flag = process.env.LOG_PRETTY;
	if (flag != null && flag !== '') return flag !== 'false' && flag !== '0';
	return process.env.NODE_ENV !== 'production';
}

function makeRoot(): pino.Logger {
	if (usePretty()) {
		const stream = pretty({
			colorize: true,
			singleLine: true, // keep bound correlation fields on the same line
			translateTime: 'SYS:HH:MM:ss.l',
			// `ns` is rendered (colored) by messageFormat; host/pid are constant per
			// process and only clutter the dev stream (they remain in prod JSON).
			ignore: `${NS_KEY},pid,hostname,host`,
			messageFormat: (log, messageKey) => {
				const ns = log[NS_KEY] ? `${paintNamespace(String(log[NS_KEY]))} ` : '';
				return `${ns}${log[messageKey] ?? ''}`;
			}
		});
		return pino({ level: LEVEL }, stream);
	}
	// Prod: newline-delimited JSON to stdout. `base: null` drops pino's default
	// pid/hostname bindings so callers bind exactly the correlation they want.
	return pino({ level: LEVEL, base: null });
}

/** The process-wide base logger. Namespaced/correlation children descend from it. */
export const rootLogger: pino.Logger = makeRoot();

/**
 * A namespaced child logger. The namespace is carried as the `ns` field (a stable
 * color in dev, a plain field in prod JSON). Add correlation with `.child(...)`:
 *
 *     const log = logger('crawl').child({ workerId, runId, mode, phase });
 */
export function logger(namespace: string): pino.Logger {
	return rootLogger.child({ [NS_KEY]: namespace });
}

/** Re-exported for convenient type annotations at call sites. */
export type Logger = pino.Logger;
