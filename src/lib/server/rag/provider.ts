// Retrieval-provider switch (#63). One env var, `RETRIEVAL_PROVIDER`, selects which
// implementation of the `retrieve()` contract the pipeline uses:
//
//   • vectorize (default) — our custom pipeline: embed the query + libSQL
//     `vector_top_k` over the `chunk` index (rag/retrieve.ts).
//   • ai-search           — Cloudflare AI Search's managed retrieval endpoint
//     (rag/search.ts), indexing the cleaned-text export (worker/index-export.ts).
//
// Both conform to the SAME signature and `{ passages, sources, context }` return,
// so everything downstream (answer.ts, the #39 eval) is provider-agnostic — the
// choice is config, not code. Default is `vectorize`, so unset/unknown values keep
// today's behaviour exactly.
import { retrieve, type RetrievalResult, type RetrieveOptions } from './retrieve';
import { search } from './search';

/** The shared retrieval contract both providers implement. */
export type Retriever = (question: string, opts?: RetrieveOptions) => Promise<RetrievalResult>;

export type RetrievalProvider = 'vectorize' | 'ai-search';

export const DEFAULT_RETRIEVAL_PROVIDER: RetrievalProvider = 'vectorize';

/** Normalize a provider name; anything unrecognised falls back to the default so a
 *  typo can never silently disable retrieval. */
export function resolveProvider(name?: string): RetrievalProvider {
	const v = (name ?? process.env.RETRIEVAL_PROVIDER ?? '').trim().toLowerCase();
	return v === 'ai-search' ? 'ai-search' : DEFAULT_RETRIEVAL_PROVIDER;
}

/** Pick the retrieval function for the given (or configured) provider. */
export function selectRetriever(provider?: string): Retriever {
	return resolveProvider(provider) === 'ai-search' ? search : retrieve;
}
