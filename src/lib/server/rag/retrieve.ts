// Retrieval — stage 3 of the RAG pipeline (#36). The QUERY side of what stages
// 1–2 built: given a natural-language question it embeds the question, runs an
// approximate-nearest-neighbour search (`vector_top_k`) over the `chunk` table's
// libSQL-native vector index (`chunk_vec_idx`, #35), and assembles the nearest
// passages — with source attribution — into a grounded context the answer stage
// (#37) can feed straight to an LLM.
//
// Two correctness invariants:
//   • Same embedder as indexing. The question MUST be embedded with the exact
//     model/config the chunks were embedded with (#35), or the query vector isn't
//     comparable to the stored vectors and cosine search returns noise. We reuse
//     the very same `Embedder` (worker/embeddings.ts → selectEmbedder), driven by
//     the same EMBEDDING_PROVIDER + credentials — not a re-implementation — so the
//     two sides can never silently drift apart. No query-time prefixing: chunks
//     were embedded from raw text, so the question is too.
//   • Only live content. `vector_top_k` searches the whole index including chunks
//     of resources that have since gone 404/410 or errored; we join back to
//     `resource.state` and drop anything not live, so a grounded answer never
//     cites a dead page.
//
// The ANN index returns a fixed k by vector distance alone; because we filter
// (state) and cap per-resource AFTER that, we over-fetch candidates and then trim
// down to the requested top-k — see CANDIDATE_MULTIPLIER.
import type { Client } from '@libsql/client';
import { selectEmbedder, type Embedder } from '../../../../worker/embeddings';

/** A retrieved chunk with its similarity score and source attribution. */
export interface Passage {
	text: string;
	/** Cosine similarity in [-1, 1] (1 − cosine distance); higher = more relevant. */
	score: number;
	url: string;
	title: string | null;
	kind: string;
	resourceId: string;
	chunkIndex: number;
}

/** One distinct source document, deduped across passages (best score kept). */
export interface Source {
	url: string;
	title: string | null;
	kind: string;
}

/** Structured retrieval result + a prompt-ready grounded context for the answerer. */
export interface RetrievalResult {
	passages: Passage[];
	/** Distinct source documents behind `passages`, ordered by best relevance. */
	sources: Source[];
	/** Passages assembled into a numbered, source-cited block ready to drop into
	 *  the answer prompt. Citation `[n]` refers to `sources[n-1]`. Empty when
	 *  nothing was retrieved. */
	context: string;
}

export interface RetrieveOptions {
	/** How many passages to return (after filtering + per-resource capping). Default 8. */
	topK?: number;
	/** Cap passages per source document so one long page can't dominate. Default 3. */
	maxPerResource?: number;
	/** Over-fetch factor: `vector_top_k` fetches topK × this many candidates, so
	 *  state-filtering / per-resource capping still leaves enough. Default 5. */
	candidateMultiplier?: number;
	/** Inject an embedder (tests / explicit config). Defaults to `selectEmbedder()`
	 *  — the SAME selection the indexer used, so query and chunk vectors match. */
	embedder?: Embedder;
	/** Inject a libSQL client (tests). Defaults to the app's DB client. */
	client?: Client;
}

/** Default passage count + per-source cap. Exported so an alternate provider
 *  (rag/search.ts) trims to the SAME defaults and the two can't drift apart. */
export const DEFAULT_TOP_K = 8;
export const DEFAULT_MAX_PER_RESOURCE = 3;
const CANDIDATE_MULTIPLIER = 5;

interface CandidateRow {
	text: string;
	url: string;
	title: string | null;
	kind: string;
	resource_id: string;
	chunk_index: number;
	distance: number;
}

/** The app's libSQL client, imported lazily so this module stays import-safe
 *  without a configured DATABASE_URL (tests inject their own client and never
 *  hit this path). */
async function appClient(): Promise<Client> {
	const { db } = await import('../db');
	// `$client` is on drizzle()'s return intersection but not the bare
	// LibSQLDatabase type the app exports it as — it's the underlying libSQL client.
	return (db as unknown as { $client: Client }).$client;
}

/**
 * Embed `question`, ANN-search the chunk index, filter to live resources, and
 * assemble the nearest passages into a grounded context for the answer stage.
 *
 * Returns empty passages/sources and an empty context for a blank question or an
 * empty corpus — callers can treat "nothing retrieved" uniformly.
 */
export async function retrieve(
	question: string,
	opts: RetrieveOptions = {}
): Promise<RetrievalResult> {
	const topK = Math.max(1, Math.floor(opts.topK ?? DEFAULT_TOP_K));
	const maxPerResource = Math.max(1, Math.floor(opts.maxPerResource ?? DEFAULT_MAX_PER_RESOURCE));
	const candidateK = Math.max(
		topK,
		Math.floor(topK * (opts.candidateMultiplier ?? CANDIDATE_MULTIPLIER))
	);

	if (!question.trim()) return { passages: [], sources: [], context: '' };

	// Embed the query with the SAME embedder that produced the stored chunk
	// vectors — otherwise the two aren't comparable and search is meaningless.
	const embedder = selectEmbedder(opts.embedder);
	const [queryVec] = await embedder.embed([question]);
	if (!queryVec) return { passages: [], sources: [], context: '' };
	const probe = JSON.stringify(queryVec);

	// ANN search over the native vector index, joined back to `resource` so we can
	// drop chunks whose source has gone/errored. `vector_top_k` yields chunk rowids
	// nearest by vector distance; we re-derive the exact cosine distance for the
	// score and ordering. The probe vector binds as a parameter; k is inlined as a
	// validated integer (the function's arity arg isn't a bind slot).
	const client = opts.client ?? (await appClient());
	const result = await client.execute({
		sql: `SELECT
				ch.text AS text,
				ch.url AS url,
				ch.title AS title,
				ch.kind AS kind,
				ch.resource_id AS resource_id,
				ch.chunk_index AS chunk_index,
				vector_distance_cos(ch.embedding, vector32(?)) AS distance
			FROM vector_top_k('chunk_vec_idx', vector32(?), ${candidateK}) AS vtk
			JOIN chunk ch ON ch.rowid = vtk.id
			JOIN resource r ON r.id = ch.resource_id
			WHERE r.state NOT IN ('gone', 'error')
			ORDER BY distance ASC`,
		args: [probe, probe]
	});
	const rows = result.rows as unknown as CandidateRow[];

	// Cap per resource, then take the top-k. Rows arrive best-first (distance ASC).
	const perResource = new Map<string, number>();
	const passages: Passage[] = [];
	for (const row of rows) {
		if (passages.length >= topK) break;
		const seen = perResource.get(row.resource_id) ?? 0;
		if (seen >= maxPerResource) continue;
		perResource.set(row.resource_id, seen + 1);
		passages.push({
			text: row.text,
			score: 1 - row.distance, // cosine distance → similarity
			url: row.url,
			title: row.title,
			kind: row.kind,
			resourceId: row.resource_id,
			chunkIndex: row.chunk_index
		});
	}

	const sources = dedupeSources(passages);
	const context = assembleContext(passages, sources);
	return { passages, sources, context };
}

/** Distinct source documents, in order of first (i.e. best-scoring) appearance.
 *  Exported so an alternate retrieval provider (see rag/search.ts) assembles its
 *  `sources`/`context` IDENTICALLY — the two must be drop-in interchangeable. */
export function dedupeSources(passages: Passage[]): Source[] {
	const seen = new Set<string>();
	const sources: Source[] = [];
	for (const p of passages) {
		if (seen.has(p.url)) continue;
		seen.add(p.url);
		sources.push({ url: p.url, title: p.title, kind: p.kind });
	}
	return sources;
}

/** Number each passage with its source's citation `[n]`, then list the sources —
 *  a compact, grounded block the answerer can quote and cite from. Exported so an
 *  alternate retrieval provider (rag/search.ts) produces a byte-identical context. */
export function assembleContext(passages: Passage[], sources: Source[]): string {
	if (passages.length === 0) return '';
	const citation = new Map(sources.map((s, i) => [s.url, i + 1]));
	const body = passages.map((p) => `[${citation.get(p.url)}] ${p.text}`).join('\n\n');
	const cited = sources
		.map((s, i) => `[${i + 1}] ${s.title?.trim() || s.url} — ${s.url}`)
		.join('\n');
	return `${body}\n\nSources:\n${cited}`;
}
