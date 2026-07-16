// Standalone DB client for the worker. Unlike src/lib/server/db/index.ts (which
// pulls config from SvelteKit's `$app/env` virtual module) this reads plain
// process.env, so it runs in a bare Bun process. It reuses the *same* Drizzle
// schema as the app, so both sides share one source of truth.
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../src/lib/server/db/schema';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

export const client = createClient({
	url,
	authToken: process.env.DATABASE_AUTH_TOKEN || undefined
});

export const db = drizzle(client, { schema });
export { schema };
