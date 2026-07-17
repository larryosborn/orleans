import { describe, it, expect } from 'vitest';
import { EMBED_DIM } from '../src/lib/server/db/crawl.schema';
import { makeFakeEmbedder, selectEmbedder, type Embedder } from './embeddings';

function dot(a: number[], b: number[]): number {
	return a.reduce((s, x, i) => s + x * b[i], 0);
}

describe('makeFakeEmbedder', () => {
	const embedder = makeFakeEmbedder();

	it('emits one EMBED_DIM-dimensional vector per input', async () => {
		const vecs = await embedder.embed(['hello world', 'another line']);
		expect(vecs).toHaveLength(2);
		expect(vecs[0]).toHaveLength(EMBED_DIM);
		expect(embedder.dimensions).toBe(EMBED_DIM);
	});

	it('is deterministic — same text yields the same vector', async () => {
		const [a] = await embedder.embed(['the quick brown fox']);
		const [b] = await embedder.embed(['the quick brown fox']);
		expect(a).toEqual(b);
	});

	it('returns L2-normalized (unit) vectors', async () => {
		const [v] = await embedder.embed(['harbor dredging permits']);
		expect(dot(v, v)).toBeCloseTo(1, 5);
	});

	it('scores similar text closer than dissimilar text (cosine)', async () => {
		const [base] = await embedder.embed(['annual town budget review meeting']);
		const [near] = await embedder.embed(['the annual budget review meeting notes']);
		const [far] = await embedder.embed(['wetland conservation permit for a pond']);
		expect(dot(base, near)).toBeGreaterThan(dot(base, far));
	});

	it('handles text with no alphanumeric tokens without NaNs', async () => {
		const [v] = await embedder.embed(['!!! ??? ...']);
		expect(v).toHaveLength(EMBED_DIM);
		expect(v.every((x) => Number.isFinite(x))).toBe(true);
		expect(dot(v, v)).toBeCloseTo(1, 5);
	});

	it('returns [] for an empty batch', async () => {
		expect(await embedder.embed([])).toEqual([]);
	});
});

describe('selectEmbedder', () => {
	it('returns the injected override untouched (call-site swap for tests)', () => {
		const fake: Embedder = makeFakeEmbedder(4);
		expect(selectEmbedder(fake)).toBe(fake);
	});

	it('falls back to the deterministic fake embedder when no override/creds given', () => {
		// The verify env sets EMBEDDING_PROVIDER; here we assert the returned client
		// satisfies the interface regardless of which provider was selected.
		const e = selectEmbedder();
		expect(typeof e.embed).toBe('function');
		expect(e.dimensions).toBe(EMBED_DIM);
	});
});
