import { ORIGIN, BETTER_AUTH_SECRET } from '$app/env/private';
import { betterAuth } from 'better-auth/minimal';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { getRequestEvent } from '$app/server';
import { db } from '$lib/server/db';

type Auth = ReturnType<typeof betterAuth>;

// Lazily-constructed singleton. `betterAuth()` reads ORIGIN/BETTER_AUTH_SECRET and
// wires up the DB adapter, so constructing it eagerly would run during SvelteKit's
// build (route analysis), where those runtime values are absent. Deferring
// construction to first use keeps the module import-safe.
let instance: Auth | undefined;

function getAuth(): Auth {
	if (!instance) {
		// In dev, derive the origin from the current request so any port works
		// without an ORIGIN value (each dev server is its own process, so it bakes
		// its own port). In production, pin it to ORIGIN (safer against host spoofing).
		const isDev = import.meta.env.DEV;
		let baseURL: string | undefined = ORIGIN || undefined;
		if (isDev) {
			try {
				baseURL = new URL(getRequestEvent().request.url).origin;
			} catch {
				baseURL = undefined; // constructed outside a request; fall back to inference
			}
		}
		instance = betterAuth({
			baseURL,
			trustedOrigins: isDev
				? (request?: Request) => (request ? [new URL(request.url).origin] : [])
				: undefined,
			secret: BETTER_AUTH_SECRET,
			database: drizzleAdapter(db, { provider: 'sqlite' }),
			emailAndPassword: { enabled: true },
			plugins: [
				sveltekitCookies(getRequestEvent) // make sure this is the last plugin in the array
			]
		});
	}
	return instance;
}

// Value-import façade so callers keep using `auth.api.signInEmail(...)` etc.
// Property access constructs the singleton on first use, which only ever happens
// while handling a request — never at import/build time.
export const auth = new Proxy({} as Auth, {
	get(_target, prop) {
		const value = Reflect.get(getAuth(), prop, getAuth());
		return typeof value === 'function' ? value.bind(getAuth()) : value;
	},
	has: (_target, prop) => prop in getAuth()
});
