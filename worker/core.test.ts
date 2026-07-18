// Core seam test — drives the resumable `tick()` against a throwaway libSQL file
// DB with a mocked (offline) site, covering issue #27's load-bearing guarantees:
//   • driving tick() repeatedly runs a `sync` run to completion (criterion 3),
//   • a tiny per-tick budget forces many bounded ticks — no unbounded loop
//     (criterion 1) — and interrupting between ticks then resuming completes the
//     run correctly (criterion 4),
//   • re-running over unchanged content adds NO duplicate version rows — atomic &
//     idempotent advance (criterion 6).
import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://www.town.orleans.ma.us';

// In-memory fake site, shared with the ./http mock via vi.hoisted (hoisted above
// the dynamic imports in beforeAll).
const site = vi.hoisted(() => ({ pages: new Map<string, { ct: string; body: string }>() }));

// Mock ./storage — it imports Bun's S3Client at module load, which vitest's node
// runner can't resolve. An in-memory content-addressed writer is all the sync
// crawl needs (it exercises dedupe/refcount in the DB, not the bytes backend).
vi.mock('./storage', () => ({
	makeBlobWriter: () => ({
		publish: false,
		label: 'test (in-memory)',
		async putIfAbsent(sha256: string, ext: string) {
			return { key: `blobs/${sha256}${ext}`, r2Synced: false };
		},
		async ensurePublished() {
			return false;
		}
	}),
	// Stubs — the extract/embed modules import these but aren't driven by this test.
	localDir: () => '/tmp/blobs',
	makeLocalStorage: () => ({}),
	makeR2Storage: () => null
}));

// Mock only the NETWORK seam of ./http (politeFetch + Robots); keep every pure
// helper (normalize/inScope/sha256Hex/parseSitemap…) real so the engine runs for
// real, just offline.
vi.mock('./http', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./http')>();
	return {
		...actual,
		Robots: { load: async () => ({ canFetch: () => true }) },
		politeFetch: async (url: string) => {
			const p = site.pages.get(url);
			if (!p) return { resp: new Response('', { status: 404 }), throttled: false };
			return {
				resp: new Response(p.body, { status: 200, headers: { 'Content-Type': p.ct } }),
				throttled: false
			};
		}
	};
});

const drizzleDir = fileURLToPath(new URL('../drizzle/', import.meta.url));

/* eslint-disable @typescript-eslint/no-explicit-any */
let tmp: string;
let db: any;
let client: any;
let schema: any;
let tick: any;
let DEFAULT_BUDGET: any;

const IDENTITY = { id: 'test-worker', host: 'test', pid: 1 };

function sitemap(urls: string[]): string {
	const body = urls.map((u) => `<url><loc>${u}</loc></url>`).join('');
	return `<?xml version="1.0"?><urlset>${body}</urlset>`;
}

function page(text: string, links: string[] = []): string {
	const a = links.map((u) => `<a href="${u}">x</a>`).join('');
	return `<!doctype html><html><head><title>T</title></head><body><main>${text} ${a}</main></body></html>`;
}

beforeAll(async () => {
	// The engine runs under the Bun runtime in production; vitest's node runner has
	// no global `Bun`. Two surfaces are reached here: `Bun.sleep` (politeDelay) and
	// `Bun.CryptoHasher` (sha256Hex) — shim both, the latter via node's crypto.
	const { createHash } = await import('node:crypto');
	class CryptoHasher {
		private h;
		constructor(algo: string) {
			this.h = createHash(algo);
		}
		update(data: Uint8Array | string) {
			this.h.update(data);
			return this;
		}
		digest(enc: string) {
			return this.h.digest(enc as 'hex');
		}
	}
	(globalThis as unknown as { Bun?: unknown }).Bun ??= {
		sleep: () => Promise.resolve(),
		CryptoHasher
	};
	tmp = mkdtempSync(join(tmpdir(), 'core-tick-'));
	// worker/db.ts + config.ts read env at import time — set before importing.
	process.env.DATABASE_URL = `file:${join(tmp, 'test.db')}`;
	delete process.env.DATABASE_AUTH_TOKEN;
	process.env.CRAWLER_RATE_LIMIT = '0'; // no polite delay in tests
	process.env.CRAWLER_RATE_LIMIT_JITTER = '0';
	process.env.CRAWLER_SEEDS = `${BASE}/page-a`; // single seed root
	({ db, client } = await import('./db'));
	schema = await import('../src/lib/server/db/schema');
	const { applyMigrations } = await import('../src/lib/server/db/migrator');
	({ tick, DEFAULT_BUDGET } = await import('./core'));
	const entries = readdirSync(drizzleDir)
		.filter((f) => f.endsWith('.sql'))
		.map((name) => ({ name, sql: readFileSync(join(drizzleDir, name), 'utf8') }));
	await applyMigrations(client, entries);

	// A 3-page site: page-a links to b and c; the sitemap lists all three.
	site.pages.set(`${BASE}/sitemap.xml`, {
		ct: 'application/xml',
		body: sitemap([`${BASE}/page-a`, `${BASE}/page-b`, `${BASE}/page-c`])
	});
	site.pages.set(`${BASE}/page-a`, {
		ct: 'text/html',
		body: page('alpha', [`${BASE}/page-b`, `${BASE}/page-c`])
	});
	site.pages.set(`${BASE}/page-b`, { ct: 'text/html', body: page('bravo') });
	site.pages.set(`${BASE}/page-c`, { ct: 'text/html', body: page('charlie') });
});

afterAll(() => {
	client?.close();
	if (tmp) rmSync(tmp, { recursive: true, force: true });
});

async function enqueueSync(): Promise<string> {
	const [run] = await db
		.insert(schema.syncRun)
		.values({ mode: 'sync', status: 'queued', requestedBy: 'test' })
		.returning();
	return run.id;
}
async function count(table: string): Promise<number> {
	const r = await client.execute(`select count(*) n from ${table}`);
	return Number(r.rows[0].n);
}
async function runStatus(id: string): Promise<string> {
	const r = await client.execute({ sql: 'select status from sync_run where id=?', args: [id] });
	return String(r.rows[0].status);
}

describe('tick() core', () => {
	it('drives a sync run to completion over many bounded ticks (criteria 1 + 3)', async () => {
		const id = await enqueueSync();

		// A tiny budget (1 item/tick) forces MANY ticks — proving the core is bounded
		// (no unbounded loop) and that pumping it repeatedly completes the run.
		const budget = { maxItems: 1, timeBudgetMs: 60_000 };
		const statuses: string[] = [];
		let guard = 0;
		for (;;) {
			const r = await tick({ identity: IDENTITY, publish: false, budget });
			statuses.push(r.status);
			if (r.status === 'done') break;
			if (r.status === 'idle' && !r.runId) break;
			if (++guard > 200) throw new Error('tick did not converge');
		}

		expect(await runStatus(id)).toBe('completed');
		// 3 real pages fetched + stored → 3 version rows, 3 blobs.
		expect(await count('resource_version')).toBe(3);
		expect(await count('blob')).toBe(3);
		// It genuinely took multiple ticks (a `more` before the terminal `done`).
		expect(statuses.filter((s) => s === 'more').length).toBeGreaterThan(0);
		expect(statuses.at(-1)).toBe('done');

		// A follow-up tick with nothing queued is idle (no work), runId null.
		const idle = await tick({ identity: IDENTITY, publish: false, budget });
		expect(idle.status).toBe('idle');
		expect(idle.runId).toBeNull();
	});

	it('is idempotent: re-running over unchanged content adds no new version rows (criterion 6)', async () => {
		const versionsBefore = await count('resource_version');

		// Force every resource due again and re-run to completion.
		await client.execute('update resource set next_fetch_at = null');
		const id = await enqueueSync();
		let guard = 0;
		for (;;) {
			const r = await tick({ identity: IDENTITY, publish: false, budget: DEFAULT_BUDGET });
			if (r.status === 'done') break;
			if (r.status === 'idle' && !r.runId) break;
			if (++guard > 200) throw new Error('tick did not converge');
		}

		expect(await runStatus(id)).toBe('completed');
		// Same bytes → same sha → recorded `unchanged` → NO new version rows.
		expect(await count('resource_version')).toBe(versionsBefore);
	});

	it('resumes correctly when interrupted between ticks (criterion 4)', async () => {
		// Change page-b's content (text only — no new links) so the resume run has
		// exactly one real change to persist.
		site.pages.set(`${BASE}/page-b`, { ct: 'text/html', body: page('bravo-edited') });
		await client.execute('update resource set next_fetch_at = null');
		const id = await enqueueSync();
		const versionsBefore = await count('resource_version');

		// Pump just TWO bounded ticks, then "interrupt" (stop calling tick).
		const budget = { maxItems: 1, timeBudgetMs: 60_000 };
		await tick({ identity: IDENTITY, publish: false, budget });
		await tick({ identity: IDENTITY, publish: false, budget });
		expect(await runStatus(id)).toBe('running'); // not finished yet — mid-run

		// Resume: keep pumping the same core to completion.
		let guard = 0;
		for (;;) {
			const r = await tick({ identity: IDENTITY, publish: false, budget });
			if (r.status === 'done') break;
			if (r.status === 'idle' && !r.runId) break;
			if (++guard > 200) throw new Error('tick did not converge');
		}

		expect(await runStatus(id)).toBe('completed');
		// Exactly one new version (page-b changed); a and c unchanged → no dup rows.
		expect(await count('resource_version')).toBe(versionsBefore + 1);
	});
});
