// Pipeline integration test for `executeEmbed` — drives the real worker task
// (via worker/db.ts) against a throwaway libSQL file DB with an injected fake
// embedder, covering the spec's subtlest behaviour: chunks populate (criterion
// 2), a content change re-embeds ONLY the changed resource, and content that
// stops being `ok` leaves no orphan chunks (criterion 3).
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFakeEmbedder } from './embeddings';

const drizzleDir = fileURLToPath(new URL('../drizzle/', import.meta.url));

/* eslint-disable @typescript-eslint/no-explicit-any */
let tmp: string;
let db: any;
let client: any;
let schema: any;
let executeEmbed: any;

beforeAll(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'embed-pipe-'));
	// worker/db.ts reads DATABASE_URL at import time, so set it before importing.
	process.env.DATABASE_URL = `file:${join(tmp, 'test.db')}`;
	delete process.env.DATABASE_AUTH_TOKEN;
	({ db, client } = await import('./db'));
	schema = await import('../src/lib/server/db/schema');
	const { applyMigrations } = await import('../src/lib/server/db/migrator');
	({ executeEmbed } = await import('./embed'));
	const entries = readdirSync(drizzleDir)
		.filter((f) => f.endsWith('.sql'))
		.map((name) => ({ name, sql: readFileSync(join(drizzleDir, name), 'utf8') }));
	await applyMigrations(client, entries);
});

afterAll(() => {
	client?.close();
	if (tmp) rmSync(tmp, { recursive: true, force: true });
});

async function seedResource(id: string, url: string, title: string): Promise<void> {
	await db
		.insert(schema.resource)
		.values({ id, url, urlHash: id + 'h', host: 'x', path: '/p', title });
}
async function seedText(
	resourceId: string,
	sha: string,
	status: string,
	text: string
): Promise<void> {
	await db
		.insert(schema.resourceText)
		.values({
			resourceId,
			sha256: sha,
			contentType: 'text/html',
			status,
			text,
			charCount: text.length
		})
		.onConflictDoUpdate({
			target: schema.resourceText.resourceId,
			set: { sha256: sha, status, text, charCount: text.length }
		});
}
async function embedRun(): Promise<void> {
	const [run] = await db
		.insert(schema.syncRun)
		.values({ mode: 'embed', status: 'queued', requestedBy: 'test' })
		.returning();
	await executeEmbed(run, { embedder: makeFakeEmbedder() });
}
async function chunkCount(resourceId: string): Promise<number> {
	const r = await client.execute({
		sql: 'select count(*) n from chunk where resource_id=?',
		args: [resourceId]
	});
	return Number(r.rows[0].n);
}
async function chunkIds(resourceId: string): Promise<string> {
	const r = await client.execute({
		sql: 'select id from chunk where resource_id=? order by chunk_index',
		args: [resourceId]
	});
	return r.rows.map((x: { id: unknown }) => String(x.id)).join(',');
}

const TEXT_R1 =
	'The Select Board reviews the annual town budget and harbor dredging permits at Town Hall.';
const TEXT_R2 =
	'The Conservation Commission issues wetland orders of conditions for pond-side construction.';

describe('executeEmbed pipeline', () => {
	it('populates chunks with embeddings for extracted resources (criterion 2)', async () => {
		await seedResource('r1', 'https://x/board', 'Board');
		await seedResource('r2', 'https://x/cons', 'Conservation');
		await seedText('r1', 'shaA', 'ok', TEXT_R1);
		await seedText('r2', 'shaB', 'ok', TEXT_R2);
		await embedRun();

		expect(await chunkCount('r1')).toBeGreaterThan(0);
		expect(await chunkCount('r2')).toBeGreaterThan(0);
		const row = await client.execute(
			"select source_sha, vector_extract(embedding) v from chunk where resource_id='r1' limit 1"
		);
		expect(String(row.rows[0].source_sha)).toBe('shaA');
		expect(JSON.parse(String(row.rows[0].v))).toHaveLength(768);
	});

	it('re-embeds only the changed resource (criterion 3)', async () => {
		const r2Before = await chunkIds('r2');
		expect(r2Before.length).toBeGreaterThan(0);

		await seedText('r1', 'shaA2', 'ok', TEXT_R1 + ' The meeting airs on cable channel 18.');
		await embedRun();

		const r1After = await client.execute(
			"select distinct source_sha s from chunk where resource_id='r1'"
		);
		expect(String(r1After.rows[0].s)).toBe('shaA2'); // r1 rebuilt
		expect(await chunkIds('r2')).toBe(r2Before); // r2 untouched
	});

	it('is a no-op when nothing changed', async () => {
		const before = await chunkIds('r1');
		await embedRun();
		expect(await chunkIds('r1')).toBe(before); // same rows — not rewritten
	});

	it('removes chunks when a resource stops being ok — no orphans (criterion 3)', async () => {
		const r2Count = await chunkCount('r2');
		await seedText('r1', 'shaA3', 'scanned', '');
		await embedRun();

		expect(await chunkCount('r1')).toBe(0); // orphans cleared
		expect(await chunkCount('r2')).toBe(r2Count); // unrelated resource intact
	});

	it('keeps nav/boilerplate chunks out of the index but retains content (#59)', async () => {
		// A pure nav/index page (real How-Do-I index chunk): menu strip + link labels,
		// no prose. Every chunk is low-signal, so none should reach `chunk`.
		const NAV =
			'Government Community Business Visiting Orleans How Do I... HomeHow Do I... A A ' +
			'Employment Opportunities Beach and OSV Stickers Passports Building Permits ' +
			'Senior Tax Work-Off Program Universal Pre-K Program Rental Registration ' +
			'Departments & Staff Police Department Select Board Flood Map Information ' +
			'Channel 1072 Live Stream CivicReady Emergency Alerts NotifyMe Website ' +
			'Notifications EyeOnWater Voting Recreation Activities Video Archive Requests';
		await seedResource('r3', 'https://x/how-do-i', 'How Do I');
		await seedText('r3', 'shaC', 'ok', NAV);
		// A genuine FAQ answer alongside it — must be retained.
		await seedResource('r4', 'https://x/faq', 'FAQ');
		await seedText(
			'r4',
			'shaD',
			'ok',
			'An abatement is a reduction in your property assessment that you can apply for if ' +
				'you believe that assessment does not accurately reflect the market value of your home.'
		);
		await embedRun();

		expect(await chunkCount('r3')).toBe(0); // all nav chunks filtered out
		expect(await chunkCount('r4')).toBeGreaterThan(0); // real content retained
	});
});
