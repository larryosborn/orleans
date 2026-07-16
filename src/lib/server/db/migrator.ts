// Runtime migration runner, shared by the web app and the worker. Applies the
// drizzle-generated migration files (drizzle/*.sql) in order, tracked in a
// `_migrations` table so each runs exactly once. Pure libSQL client calls (no
// filesystem, no drizzle-kit CLI), so it works on Cloudflare/Vercel serverless,
// Node, and Bun alike.
//
// Statements that CREATE something already present are tolerated: on a database
// previously bootstrapped by the old schema.sql path, the baseline migration is
// effectively idempotent, then recorded so later migrations apply cleanly.
import type { Client } from '@libsql/client';

export interface MigrationEntry {
	name: string; // file name, e.g. 0000_optimal_avengers.sql — drives ordering
	sql: string;
}

export async function applyMigrations(
	client: Client,
	entries: MigrationEntry[]
): Promise<string[]> {
	await client.execute(
		`CREATE TABLE IF NOT EXISTS "_migrations" ("name" text PRIMARY KEY NOT NULL, "applied_at" integer NOT NULL)`
	);
	const existing = await client.execute(`SELECT name FROM "_migrations"`);
	const applied = new Set(existing.rows.map((r) => String(r.name)));

	const ordered = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	const ran: string[] = [];

	for (const { name, sql } of ordered) {
		if (applied.has(name)) continue;
		const statements = sql
			.split('--> statement-breakpoint')
			.map((s) => s.trim())
			.filter(Boolean);
		for (const stmt of statements) {
			try {
				await client.execute(stmt);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				// Tolerate re-creates when catching up an already-bootstrapped DB.
				if (!/already exists/i.test(msg)) {
					throw new Error(`migration ${name} failed: ${msg}`, { cause: err });
				}
			}
		}
		await client.execute({
			sql: `INSERT OR IGNORE INTO "_migrations" ("name", "applied_at") VALUES (?, ?)`,
			args: [name, Date.now()]
		});
		ran.push(name);
	}
	return ran;
}
