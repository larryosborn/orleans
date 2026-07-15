import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { hashPassword } from 'better-auth/crypto';
import * as schema from './schema';
import schemaSql from './schema.sql?raw';
import { DATABASE_URL, DATABASE_AUTH_TOKEN } from '$app/env/private';

if (!DATABASE_URL) throw new Error('DATABASE_URL is not set');

// authToken is required for remote libSQL/Turso (Cloudflare) and ignored for
// local/Vercel file databases. The client resolves to the web build
// automatically on Cloudflare via @libsql/client's `workerd` export condition.
const client = createClient({
	url: DATABASE_URL,
	authToken: DATABASE_AUTH_TOKEN || undefined
});

export const db = drizzle(client, { schema });

// Mock database bootstrap.
//
// This app has no persistent database configured — on Vercel the DB lives in
// the function's writable /tmp dir (set DATABASE_URL=file:/tmp/local.db), which
// is empty on every cold start. So we create the schema and seed a demo admin
// user on first use. This is intentionally a throwaway/mock DB; swap in a real
// hosted libSQL/Turso URL to make it persistent.
const SEED_EMAIL = 'admin@example.com';
const SEED_PASSWORD = 'password';

let ready: Promise<void> | undefined;

export function ensureDb(): Promise<void> {
	if (!ready) ready = bootstrap();
	return ready;
}

async function bootstrap(): Promise<void> {
	await client.executeMultiple(schemaSql);

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
