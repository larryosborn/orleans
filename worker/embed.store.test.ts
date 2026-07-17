// Store-level test: applies the REAL drizzle migrations (incl. the raw-SQL ANN
// index) to a throwaway libSQL file DB, round-trips embeddings through the
// Drizzle `F32_BLOB` custom type, and runs `vector_top_k` — proving criteria 1
// (native vector column + ANN index + migration) and 4 (nearest-neighbour search)
// without any network or DATABASE_URL.
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, type Client } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { eq } from 'drizzle-orm';
import * as schema from '../src/lib/server/db/schema';
import { applyMigrations } from '../src/lib/server/db/migrator';
import { makeFakeEmbedder } from './embeddings';

const drizzleDir = fileURLToPath(new URL('../drizzle/', import.meta.url));

let tmp: string;
let client: Client;
let db: LibSQLDatabase<typeof schema>;

beforeAll(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'chunk-store-'));
	client = createClient({ url: `file:${join(tmp, 'test.db')}` });
	db = drizzle(client, { schema });
	const entries = readdirSync(drizzleDir)
		.filter((f) => f.endsWith('.sql'))
		.map((name) => ({ name, sql: readFileSync(join(drizzleDir, name), 'utf8') }));
	await applyMigrations(client, entries);
});

afterAll(() => {
	client?.close();
	if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('chunk vector store', () => {
	it('creates the native vector column + ANN index from the migration', async () => {
		const cols = await client.execute('PRAGMA table_info(chunk)');
		const emb = cols.rows.find((r) => r.name === 'embedding');
		expect(String(emb?.type)).toBe('F32_BLOB(768)');
		const idx = await client.execute(
			"SELECT name FROM sqlite_master WHERE type='index' AND name='chunk_vec_idx'"
		);
		expect(idx.rows).toHaveLength(1);
	});

	it('round-trips an embedding through the Drizzle custom type', async () => {
		const embedder = makeFakeEmbedder();
		const [vec] = await embedder.embed(['round trip check']);
		await db.insert(schema.resource).values({
			id: 'res-rt',
			url: 'https://x/rt',
			urlHash: 'h',
			host: 'x',
			path: '/rt'
		});
		await db.insert(schema.chunk).values({
			resourceId: 'res-rt',
			sourceSha: 'sha-rt',
			chunkIndex: 0,
			text: 'round trip check',
			charStart: 0,
			charEnd: 16,
			embedding: vec,
			embedder: embedder.id,
			url: 'https://x/rt',
			kind: 'page'
		});
		const [row] = await db.select().from(schema.chunk).where(eq(schema.chunk.resourceId, 'res-rt'));
		expect(row.embedding).toHaveLength(768);
		// float32 precision — compare approximately
		row.embedding.forEach((x, i) => expect(x).toBeCloseTo(vec[i], 5));
	});

	it('vector_top_k returns the nearest chunk for a probe embedding', async () => {
		const embedder = makeFakeEmbedder();
		const docs = [
			{ id: 'a', text: 'annual town budget review and harbor dredging permits' },
			{ id: 'b', text: 'wetland conservation order of conditions for a pond' },
			{ id: 'c', text: 'public library summer reading program hours' }
		];
		const vectors = await embedder.embed(docs.map((d) => d.text));
		await db.insert(schema.resource).values({
			id: 'res-search',
			url: 'https://x/s',
			urlHash: 'h',
			host: 'x',
			path: '/s'
		});
		await db.insert(schema.chunk).values(
			docs.map((d, i) => ({
				resourceId: 'res-search',
				sourceSha: 'sha-s',
				chunkIndex: i,
				text: d.text,
				charStart: 0,
				charEnd: d.text.length,
				embedding: vectors[i],
				embedder: embedder.id,
				url: 'https://x/s',
				kind: 'page'
			}))
		);

		const [probe] = await embedder.embed(['harbor dredging permits and the budget review']);
		const probeJson = JSON.stringify(probe);
		const res = await client.execute({
			sql: `SELECT ch.text FROM vector_top_k('chunk_vec_idx', vector32(?), 3) AS vtk
			      JOIN chunk ch ON ch.rowid = vtk.id
			      WHERE ch.resource_id = 'res-search'
			      ORDER BY vector_distance_cos(ch.embedding, vector32(?))`,
			args: [probeJson, probeJson]
		});
		expect(res.rows.length).toBeGreaterThan(0);
		expect(String(res.rows[0].text)).toContain('budget review and harbor dredging');
	});
});
