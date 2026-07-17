import { sequence } from '@sveltejs/kit/hooks';
import { building } from '$app/env';
import { auth } from '$lib/server/auth';
import { ensureDb } from '$lib/server/db';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import type { Handle, HandleServerError } from '@sveltejs/kit';
import { getTextDirection } from '$lib/paraglide/runtime';
import { paraglideMiddleware } from '$lib/paraglide/server';
import { appLogger } from '$lib/server/app-log';

// Outermost hook: tag every request with an id, then log it exactly once when the
// response is ready — method/path/status/duration, at a level chosen by status
// class. Sits first in the sequence so it wraps the full handling (auth, i18n,
// route) and reports the real final status and total duration. Per-request
// correlation (the request id) is bound via appLogger, mirroring how the worker
// binds its per-run correlation (see worker/log.ts) rather than passing it per call.
const handleRequestLogging: Handle = async ({ event, resolve }) => {
	const requestId = crypto.randomUUID();
	event.locals.requestId = requestId;

	const start = performance.now();
	const response = await resolve(event);
	const duration = Math.round(performance.now() - start);

	const method = event.request.method;
	const path = event.url.pathname;
	const status = response.status;
	const log = appLogger('request', requestId);
	const fields = { method, path, status, duration };
	const msg = `${method} ${path} ${status} ${duration}ms`;

	// Level by status class: 5xx → error, 4xx → warn, otherwise info.
	if (status >= 500) log.error(fields, msg);
	else if (status >= 400) log.warn(fields, msg);
	else log.info(fields, msg);

	return response;
};

const handleParaglide: Handle = ({ event, resolve }) =>
	paraglideMiddleware(event.request, ({ request, locale }) => {
		event.request = request;

		return resolve(event, {
			transformPageChunk: ({ html }) =>
				html
					.replace('%paraglide.lang%', locale)
					.replace('%paraglide.dir%', getTextDirection(locale))
		});
	});

const handleBetterAuth: Handle = async ({ event, resolve }) => {
	// Bootstrap the mock DB (schema + seeded admin) before any auth query.
	if (!building) await ensureDb();

	const session = await auth.api.getSession({ headers: event.request.headers });

	if (session) {
		event.locals.session = session.session;
		event.locals.user = session.user;
	}

	return svelteKitHandler({ event, resolve, auth, building });
};

export const handle: Handle = sequence(handleRequestLogging, handleParaglide, handleBetterAuth);

// Unexpected server errors (thrown, not `error(...)` responses) land here. Log them
// at error with the request id (so they correlate to the request line above) and
// the stack — pino's default `err` serializer captures the stack. Returning nothing
// keeps SvelteKit's default error response.
//
// SvelteKit also routes plain 404s through this hook; those aren't server faults and
// the request hook already records them at warn, so we skip them (< 500) to keep the
// error stream to genuine, actionable faults.
export const handleError: HandleServerError = ({ error, event, status, message }) => {
	if (status < 500) return;
	appLogger('error', event.locals.requestId).error(
		{ err: error, status, method: event.request.method, path: event.url.pathname },
		message
	);
};
