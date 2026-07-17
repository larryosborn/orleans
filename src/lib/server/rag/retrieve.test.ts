// Retrieval test (#36). Applies the REAL drizzle migrations (incl. the raw-SQL
// ANN index) to a throwaway libSQL file DB, seeds resources + chunks embedded
// with the deterministic fake embedder, then drives `retrieve()` with the SAME
// fake embedder so query and chunk vectors are comparable. Proves: nearest chunks
// come back with correct url/title/score (criteria 1–2), gone/error resources are
// excluded (3), and the grounded-context object is assembled (4) — all offline,
// no DATABASE_URL / network (5).
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, type Client } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import * as schema from '../db/schema';
import { applyMigrations } from '../db/migrator';
import { makeFakeEmbedder } from '../../../../worker/embeddings';
import { retrieve } from './retrieve';

const drizzleDir = fileURLToPath(new URL('../../../../drizzle/', import.meta.url));
const embedder = makeFakeEmbedder();

let tmp: string;
let client: Client;
let db: LibSQLDatabase<typeof schema>;

// Four resources: three live (budget/harbor, wetlands, library) and one GONE
// whose chunk text is IDENTICAL to a probe query — so if state-filtering were
// broken it would rank first. Each resource gets one chunk for clarity.
const DOCS = [
	{
		id: 'res-budget',
		url: 'https://x/budget',
		title: 'FY25 Town Budget',
		state: 'active',
		text: 'annual town budget review and harbor dredging permits for the fiscal year'
	},
	{
		id: 'res-wetland',
		url: 'https://x/wetland',
		title: 'Conservation',
		state: 'active',
		text: 'wetland conservation order of conditions for a pond restoration project'
	},
	{
		id: 'res-library',
		url: 'https://x/library',
		title: 'Library',
		state: 'active',
		text: 'public library summer reading program hours and childrens events'
	},
	{
		id: 'res-dead',
		url: 'https://x/dead',
		title: 'Removed Page',
		state: 'gone',
		text: 'harbor dredging permits and the budget review' // == the probe query
	}
] as const;

const QUERY = 'harbor dredging permits and the budget review';

beforeAll(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'rag-retrieve-'));
	client = createClient({ url: `file:${join(tmp, 'test.db')}` });
	db = drizzle(client, { schema });
	const entries = readdirSync(drizzleDir)
		.filter((f) => f.endsWith('.sql'))
		.map((name) => ({ name, sql: readFileSync(join(drizzleDir, name), 'utf8') }));
	await applyMigrations(client, entries);

	const vectors = await embedder.embed(DOCS.map((d) => d.text));
	for (let i = 0; i < DOCS.length; i++) {
		const d = DOCS[i];
		await db.insert(schema.resource).values({
			id: d.id,
			url: d.url,
			urlHash: `h-${d.id}`,
			host: 'x',
			path: new URL(d.url).pathname,
			title: d.title,
			state: d.state
		});
		await db.insert(schema.chunk).values({
			resourceId: d.id,
			sourceSha: `sha-${d.id}`,
			chunkIndex: 0,
			text: d.text,
			charStart: 0,
			charEnd: d.text.length,
			embedding: vectors[i],
			embedder: embedder.id,
			url: d.url,
			title: d.title,
			kind: 'page'
		});
	}
});

afterAll(() => {
	client?.close();
	if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('retrieve', () => {
	it('returns the nearest live chunk with correct attribution + score', async () => {
		const { passages } = await retrieve(QUERY, { client, embedder });

		expect(passages.length).toBeGreaterThan(0);
		const top = passages[0];
		// The budget/harbor doc is the closest LIVE match to the query.
		expect(top.url).toBe('https://x/budget');
		expect(top.title).toBe('FY25 Town Budget');
		expect(top.text).toContain('harbor dredging');
		// Similarity is a real number in [-1, 1], descending across results.
		expect(top.score).toBeGreaterThan(0);
		expect(top.score).toBeLessThanOrEqual(1);
		for (let i = 1; i < passages.length; i++) {
			expect(passages[i - 1].score).toBeGreaterThanOrEqual(passages[i].score);
		}
	});

	it('excludes gone/error resources even when they are the nearest match', async () => {
		// res-dead's chunk text == the query, so it would rank #1 if not filtered.
		const { passages, sources } = await retrieve(QUERY, { client, embedder });
		expect(passages.some((p) => p.url === 'https://x/dead')).toBe(false);
		expect(passages.some((p) => p.resourceId === 'res-dead')).toBe(false);
		expect(sources.some((s) => s.url === 'https://x/dead')).toBe(false);
	});

	it('assembles a grounded-context object: deduped sources + a cited block', async () => {
		const { passages, sources, context } = await retrieve(QUERY, { client, embedder });

		// Sources deduped by url, one per distinct live resource retrieved.
		expect(sources.length).toBe(new Set(passages.map((p) => p.url)).size);
		expect(sources[0].url).toBe('https://x/budget');

		// Context is a numbered, source-cited block ready for the answerer.
		expect(context).toContain('[1]');
		expect(context).toContain('Sources:');
		expect(context).toContain('https://x/budget');
		expect(context).toContain('FY25 Town Budget');
		expect(context).toContain('harbor dredging');
	});

	it('respects topK', async () => {
		const { passages } = await retrieve(QUERY, { client, embedder, topK: 1 });
		expect(passages).toHaveLength(1);
		expect(passages[0].url).toBe('https://x/budget');
	});

	it('caps passages per resource', async () => {
		// Add a second live resource with two near-duplicate chunks; with
		// maxPerResource=1 only one of them should survive.
		await db.insert(schema.resource).values({
			id: 'res-multi',
			url: 'https://x/multi',
			urlHash: 'h-multi',
			host: 'x',
			path: '/multi',
			title: 'Multi',
			state: 'active'
		});
		const texts = ['budget review harbor permits one', 'budget review harbor permits two'];
		const vecs = await embedder.embed(texts);
		for (let i = 0; i < texts.length; i++) {
			await db.insert(schema.chunk).values({
				resourceId: 'res-multi',
				sourceSha: 'sha-multi',
				chunkIndex: i,
				text: texts[i],
				charStart: 0,
				charEnd: texts[i].length,
				embedding: vecs[i],
				embedder: embedder.id,
				url: 'https://x/multi',
				title: 'Multi',
				kind: 'page'
			});
		}
		const { passages } = await retrieve('budget review harbor permits', {
			client,
			embedder,
			maxPerResource: 1
		});
		const fromMulti = passages.filter((p) => p.resourceId === 'res-multi');
		expect(fromMulti).toHaveLength(1);
	});

	it('returns empty for a blank question', async () => {
		const result = await retrieve('   ', { client, embedder });
		expect(result.passages).toEqual([]);
		expect(result.sources).toEqual([]);
		expect(result.context).toBe('');
	});
});
