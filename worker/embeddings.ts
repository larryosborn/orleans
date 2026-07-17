// Embedding client — stage 2 of the RAG pipeline (#35). A tiny interface behind
// which the actual model lives, so the embed pipeline (worker/embed.ts) never
// names a provider: it asks `selectEmbedder()` for an `Embedder` and calls
// `.embed(texts)`. Swapping models is a config change (EMBEDDING_PROVIDER / creds),
// not a code change — satisfying "model chosen via config, swappable".
//
// Three implementations:
//   • cloudflare — Workers AI REST (`@cf/baai/bge-base-en-v1.5`, 768-dim native)
//   • openai     — OpenAI embeddings (`text-embedding-3-small`, requested at 768 dims)
//   • fake       — deterministic, offline hashing embedder (CI / no-credentials)
//
// All three emit EMBED_DIM-dimensional vectors, matching the fixed F32_BLOB
// column width, so the store never has to care which produced a given vector.
import { CLOUDFLARE_EMBED_MODEL, EMBEDDING_PROVIDER, OPENAI_EMBED_MODEL } from './config';
import { EMBED_DIM } from '../src/lib/server/db/crawl.schema';
import { workerLogger } from './log';

const log = workerLogger('embed');

export interface Embedder {
	/** Provenance id stored on each chunk (e.g. `cloudflare:@cf/baai/bge-base-en-v1.5`). */
	readonly id: string;
	readonly dimensions: number;
	/** Embed a batch of texts, returning one vector per input, in order. */
	embed(texts: string[]): Promise<number[][]>;
}

/** Guard: every provider must return exactly `dimensions` floats per input, or the
 *  vectors won't fit the F32_BLOB column — fail loud rather than corrupt the store. */
function assertShape(id: string, vectors: number[][], expected: number, dims: number): void {
	if (vectors.length !== expected) {
		throw new Error(`${id}: expected ${expected} vectors, got ${vectors.length}`);
	}
	for (const v of vectors) {
		if (v.length !== dims) {
			throw new Error(`${id}: expected ${dims}-dim vectors, got ${v.length}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Cloudflare Workers AI (REST). Needs CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN.
// ---------------------------------------------------------------------------
export function makeCloudflareEmbedder(opts?: {
	accountId?: string;
	apiToken?: string;
	model?: string;
	dimensions?: number;
}): Embedder {
	const accountId = opts?.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
	const apiToken = opts?.apiToken ?? process.env.CLOUDFLARE_API_TOKEN;
	const model = opts?.model ?? CLOUDFLARE_EMBED_MODEL;
	const dimensions = opts?.dimensions ?? EMBED_DIM;
	if (!accountId || !apiToken) {
		throw new Error('cloudflare embedder needs CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN');
	}
	const id = `cloudflare:${model}`;
	const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
	return {
		id,
		dimensions,
		async embed(texts) {
			if (texts.length === 0) return [];
			const res = await fetch(url, {
				method: 'POST',
				headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
				body: JSON.stringify({ text: texts })
			});
			if (!res.ok) {
				throw new Error(
					`cloudflare embed failed: ${res.status} ${await res.text().catch(() => '')}`
				);
			}
			const json = (await res.json()) as { result?: { data?: number[][] } };
			const vectors = json.result?.data ?? [];
			assertShape(id, vectors, texts.length, dimensions);
			return vectors;
		}
	};
}

// ---------------------------------------------------------------------------
// OpenAI embeddings (REST). Needs OPENAI_API_KEY. `text-embedding-3-small` is
// requested with dimensions=EMBED_DIM so it matches the fixed column width.
// ---------------------------------------------------------------------------
export function makeOpenAIEmbedder(opts?: {
	apiKey?: string;
	model?: string;
	dimensions?: number;
	baseUrl?: string;
}): Embedder {
	const apiKey = opts?.apiKey ?? process.env.OPENAI_API_KEY;
	const model = opts?.model ?? OPENAI_EMBED_MODEL;
	const dimensions = opts?.dimensions ?? EMBED_DIM;
	const baseUrl = opts?.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
	if (!apiKey) throw new Error('openai embedder needs OPENAI_API_KEY');
	const id = `openai:${model}`;
	return {
		id,
		dimensions,
		async embed(texts) {
			if (texts.length === 0) return [];
			const res = await fetch(`${baseUrl}/embeddings`, {
				method: 'POST',
				headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
				body: JSON.stringify({ model, input: texts, dimensions })
			});
			if (!res.ok) {
				throw new Error(`openai embed failed: ${res.status} ${await res.text().catch(() => '')}`);
			}
			const json = (await res.json()) as { data?: { embedding: number[]; index: number }[] };
			// Sort by `index` to be robust to any out-of-order response.
			const vectors = (json.data ?? [])
				.slice()
				.sort((a, b) => a.index - b.index)
				.map((d) => d.embedding);
			assertShape(id, vectors, texts.length, dimensions);
			return vectors;
		}
	};
}

// ---------------------------------------------------------------------------
// Deterministic offline embedder. Hashes tokens into `dimensions` buckets and
// L2-normalizes, so identical text → identical vector and texts that share words
// land near each other under cosine distance. Not semantic, but enough to prove
// the chunk → embed → vector_top_k path end-to-end without any network/creds.
// ---------------------------------------------------------------------------
export function makeFakeEmbedder(dimensions = EMBED_DIM): Embedder {
	return {
		id: `fake:hash-${dimensions}`,
		dimensions,
		async embed(texts) {
			return texts.map((t) => hashEmbed(t, dimensions));
		}
	};
}

function hashEmbed(text: string, dims: number): number[] {
	const vec = new Array<number>(dims).fill(0);
	const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
	for (const tok of tokens) {
		let h = 2166136261; // FNV-1a
		for (let i = 0; i < tok.length; i++) {
			h ^= tok.charCodeAt(i);
			h = Math.imul(h, 16777619);
		}
		const bucket = (h >>> 0) % dims;
		const sign = (h & 1) === 0 ? 1 : -1;
		vec[bucket] += sign;
	}
	let norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
	if (norm === 0) {
		// no alphanumeric tokens — return a stable non-zero unit vector.
		vec[0] = 1;
		norm = 1;
	}
	for (let i = 0; i < dims; i++) vec[i] /= norm;
	return vec;
}

// ---------------------------------------------------------------------------
// Provider selection. Explicit EMBEDDING_PROVIDER wins; otherwise auto-detect
// from available credentials and fall back to the deterministic fake (with a
// warning) so the pipeline always runs. Injectable via `override` for tests.
// ---------------------------------------------------------------------------
export function selectEmbedder(override?: Embedder): Embedder {
	if (override) return override;

	const provider = EMBEDDING_PROVIDER?.toLowerCase();
	if (provider === 'cloudflare') return makeCloudflareEmbedder();
	if (provider === 'openai') return makeOpenAIEmbedder();
	if (provider === 'fake') return makeFakeEmbedder();
	if (provider) throw new Error(`unknown EMBEDDING_PROVIDER: ${provider}`);

	// auto-detect
	if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN) {
		return makeCloudflareEmbedder();
	}
	if (process.env.OPENAI_API_KEY) return makeOpenAIEmbedder();

	log.warn(
		'no embedding credentials found — using the deterministic fake embedder; ' +
			'set EMBEDDING_PROVIDER=cloudflare|openai (+ credentials) for real embeddings'
	);
	return makeFakeEmbedder();
}
