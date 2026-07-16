// App-side migration loader. Vite bundles every drizzle/*.sql file as a raw
// string at build time (import.meta.glob eager), so the migrations ship inside
// the server bundle and apply at runtime with no filesystem access — the shape
// Cloudflare Workers / Vercel functions require.
import type { Client } from '@libsql/client';
import { applyMigrations, type MigrationEntry } from './migrator';

const files = import.meta.glob('/drizzle/*.sql', {
	query: '?raw',
	import: 'default',
	eager: true
}) as Record<string, string>;

const entries: MigrationEntry[] = Object.entries(files).map(([path, sql]) => ({
	name: path.split('/').pop()!,
	sql
}));

export function runMigrations(client: Client): Promise<string[]> {
	return applyMigrations(client, entries);
}
