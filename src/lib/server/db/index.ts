import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { createClient, type Client } from '@libsql/client';
import { hashPassword } from 'better-auth/crypto';
import * as schema from './schema';
import { runMigrations } from './migrate.web';
import { DATABASE_URL, DATABASE_AUTH_TOKEN } from '$app/env/private';

// Lazily-created singletons. Nothing here touches the environment or opens a
// connection at import time — the client and Drizzle instance are built on first
// use. This keeps the module import-safe during SvelteKit's build (route
// analysis), which imports it but never queries the DB and has no DATABASE_URL.
let client: Client | undefined;
let database: LibSQLDatabase<typeof schema> | undefined;

function getClient(): Client {
	if (!client) {
		if (!DATABASE_URL) throw new Error('DATABASE_URL is not set');
		// authToken is required for remote libSQL/Turso (Cloudflare) and ignored for
		// local/Vercel file databases. The client resolves to the web build
		// automatically on Cloudflare via @libsql/client's `workerd` export condition.
		client = createClient({
			url: DATABASE_URL,
			authToken: DATABASE_AUTH_TOKEN || undefined
		});
	}
	return client;
}

function getDb(): LibSQLDatabase<typeof schema> {
	if (!database) database = drizzle(getClient(), { schema });
	return database;
}

// Value-import façade so callers keep using `db.select(...)` etc. Property access
// resolves the lazy singleton on first use; methods are bound to the real Drizzle
// instance so their internal `this` is correct.
export const db = new Proxy({} as LibSQLDatabase<typeof schema>, {
	get(_target, prop) {
		const instance = getDb();
		const value = Reflect.get(instance, prop, instance);
		return typeof value === 'function' ? value.bind(instance) : value;
	},
	has: (_target, prop) => prop in getDb()
});

// Database bootstrap, run once per instance on first use (see hooks.server.ts).
//
// Applies any pending drizzle migrations (drizzle/*.sql) against the configured
// database — so schema changes ship with the code and self-apply on deploy, with
// no manual `db:migrate` step. Then seeds a demo admin the first time (handy for
// the throwaway /tmp DB on Vercel; a no-op once the user exists).
const SEED_EMAIL = 'admin@example.com';
const SEED_PASSWORD = 'password';

let ready: Promise<void> | undefined;

export function ensureDb(): Promise<void> {
	if (!ready) ready = bootstrap();
	return ready;
}

async function bootstrap(): Promise<void> {
	const client = getClient();
	await runMigrations(client);

	const existing = await client.execute({
		sql: 'select id from user where email = ? limit 1',
		args: [SEED_EMAIL]
	});
	if (existing.rows.length > 0) return;

	const userId = crypto.randomUUID();
	const now = Date.now();

	await client.execute({
		sql: 'insert into user (id, name, email, email_verified, created_at, updated_at) values (?, ?, ?, ?, ?, ?)',
		args: [userId, 'Admin', SEED_EMAIL, 1, now, now]
	});
	await client.execute({
		sql: 'insert into account (id, account_id, provider_id, user_id, password, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)',
		args: [
			crypto.randomUUID(),
			userId,
			'credential',
			userId,
			await hashPassword(SEED_PASSWORD),
			now,
			now
		]
	});
}
