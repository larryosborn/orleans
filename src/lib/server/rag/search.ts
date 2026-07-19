// AI Search retrieval provider (#63) — an ALTERNATE to the custom vectorize
// pipeline in retrieve.ts, behind the exact same `retrieve()` contract so the two
// are drop-in interchangeable (see rag/provider.ts + #39's eval switch).
//
// Where retrieve.ts embeds the question and runs libSQL `vector_top_k` over our
// own `chunk` index, this provider delegates retrieval to Cloudflare AI Search
// (the product formerly called AutoRAG): it POSTs the question to the managed
// *retrieval-only* endpoint and maps the returned chunks back into the same
// `{ passages, sources, context }` shape. The index it searches is populated by
// the R2 exporter (worker/index-export.ts), which writes each `ok` resource's
// CLEANED text plus `x-amz-meta-source-url` / `title` / `kind` custom metadata —
// so a hit here carries a real Orleans source URL for citation, not an opaque
// content-hash blob key.
//
// RETRIEVAL-ONLY, on purpose. We hit `…/ai-search/instances/{instance}/search`
// (returns ranked chunks) and NOT `…/ai-search` (which also runs the model's own
// generation). Generation stays ours — answer.ts (#37) keeps the Claude grounding
// policy on top of whatever provider retrieved the passages.
//
// Endpoint confirmed from the Cloudflare AI Search REST docs
// (developers.cloudflare.com/ai-search/usage/rest-api/): the older
// `…/autorag/rags/{name}/search` path is deprecated in favour of the
// `ai-search/instances` path used here. The response is read defensively (both the
// `data[]`/`content[]` and `chunks[]`/`text` shapes the docs describe) since the
// wire format is still settling and this can only be verified live with creds (#62).
import {
	assembleContext,
	dedupeSources,
	DEFAULT_MAX_PER_RESOURCE,
	DEFAULT_TOP_K,
	type Passage,
	type RetrievalResult,
	type RetrieveOptions,
	type Source
} from './retrieve';

// DEFAULT_TOP_K / DEFAULT_MAX_PER_RESOURCE are imported from retrieve.ts (not
// re-declared) so both providers trim to the same defaults and can't drift apart.

/** Cloudflare REST API base. Overridable for tests (point at a fake server). */
const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

/** The injectable `fetch` seam — Node/Bun/Workers all expose this global shape. */
export type FetchLike = (
	input: string,
	init?: {
		method?: string;
		headers?: Record<string, string>;
		body?: string;
	}
) => Promise<{
	ok: boolean;
	status: number;
	json: () => Promise<unknown>;
	text: () => Promise<string>;
}>;

/** AI Search-specific knobs. Extends RetrieveOptions so the provider switch can
 *  hand either provider the SAME `RetrieveOptions` (topK is honored; the extra
 *  fields default from env / a real `fetch`). */
export interface SearchOptions extends RetrieveOptions {
	/** Cloudflare account id. Defaults to `CF_ACCOUNT_ID`. */
	accountId?: string;
	/** AI Search instance name. Defaults to `AI_SEARCH_INSTANCE`. */
	instance?: string;
	/** Bearer token (AI Search:Run). Defaults to `AI_SEARCH_TOKEN`. */
	token?: string;
	/** Injected fetch (tests / non-standard runtime). Defaults to global `fetch`. */
	fetch?: FetchLike;
	/** Override the REST API base (tests). Defaults to the Cloudflare base. */
	apiBase?: string;
}

// ---------------------------------------------------------------------------
// The AI Search retrieval response, modelled loosely so both documented shapes
// map cleanly. Every field is optional because we never trust the wire fully.
// ---------------------------------------------------------------------------
interface AiSearchContentPart {
	type?: string;
	text?: string;
}
interface AiSearchResultItem {
	// AutoRAG-era identity fields
	file_id?: string;
	filename?: string;
	id?: string;
	score?: number;
	// text: an array of content parts (AutoRAG) OR a flat string (chunks[] shape)
	content?: AiSearchContentPart[] | string;
	text?: string;
	// custom metadata surfaces here (attributes) or nested under item.metadata
	attributes?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
	item?: { key?: string; metadata?: Record<string, unknown> };
}
interface AiSearchResponse {
	result?: {
		data?: AiSearchResultItem[];
		chunks?: AiSearchResultItem[];
	};
	// some shapes return data/chunks at the top level
	data?: AiSearchResultItem[];
	chunks?: AiSearchResultItem[];
	success?: boolean;
	errors?: unknown;
}

/** Read a config value from opts, else env, else throw a pointed error. */
function required(value: string | undefined, envName: string, label: string): string {
	const v = value ?? process.env[envName];
	if (!v) {
		throw new Error(
			`AI Search retrieval needs ${label} — set ${envName} or pass it via SearchOptions.`
		);
	}
	return v;
}

/** Flatten an item's text: content parts joined, or the flat `text`, trimmed. */
function itemText(item: AiSearchResultItem): string {
	if (typeof item.content === 'string') return item.content.trim();
	if (Array.isArray(item.content)) {
		return item.content
			.map((p) => p.text ?? '')
			.join('')
			.trim();
	}
	return (item.text ?? '').trim();
}

/** The metadata bag for an item, wherever the wire put it. */
function itemMeta(item: AiSearchResultItem): Record<string, unknown> {
	return { ...(item.item?.metadata ?? {}), ...(item.metadata ?? {}), ...(item.attributes ?? {}) };
}

/** Read one metadata key, tolerating the `x-amz-meta-` prefix and `-`/`_` spelling. */
function readMeta(meta: Record<string, unknown>, key: string): string | undefined {
	for (const candidate of [
		key,
		`x-amz-meta-${key}`,
		key.replace(/-/g, '_'),
		`x-amz-meta-${key.replace(/-/g, '_')}`
	]) {
		const v = meta[candidate];
		if (typeof v === 'string' && v.trim()) return v.trim();
	}
	return undefined;
}

/**
 * Retrieve via Cloudflare AI Search. Same signature/return as retrieve() so it's a
 * drop-in provider: embeds nothing locally, POSTs the question to the managed
 * retrieval endpoint, and maps each result's text/score + `source-url`/`title`/`kind`
 * custom metadata into passages with real source attribution.
 *
 * Returns empty passages/sources/context for a blank question or an empty result —
 * callers treat "nothing retrieved" uniformly across providers.
 */
export async function search(question: string, opts: SearchOptions = {}): Promise<RetrievalResult> {
	if (!question.trim()) return { passages: [], sources: [], context: '' };

	const topK = Math.max(1, Math.floor(opts.topK ?? DEFAULT_TOP_K));
	const maxPerResource = Math.max(1, Math.floor(opts.maxPerResource ?? DEFAULT_MAX_PER_RESOURCE));
	const accountId = required(opts.accountId, 'CF_ACCOUNT_ID', 'a Cloudflare account id');
	const instance = required(opts.instance, 'AI_SEARCH_INSTANCE', 'an AI Search instance name');
	const token = required(opts.token, 'AI_SEARCH_TOKEN', 'an API token');
	const doFetch = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
	const base = (opts.apiBase ?? CF_API_BASE).replace(/\/$/, '');

	const url = `${base}/accounts/${accountId}/ai-search/instances/${encodeURIComponent(instance)}/search`;
	const res = await doFetch(url, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${token}`,
			'content-type': 'application/json'
		},
		body: JSON.stringify({ query: question, max_num_results: topK })
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => '');
		throw new Error(`AI Search retrieval failed (${res.status})${detail ? `: ${detail}` : ''}`);
	}

	const payload = (await res.json()) as AiSearchResponse;
	const items =
		payload.result?.data ?? payload.result?.chunks ?? payload.data ?? payload.chunks ?? [];

	// Rank order is the provider's; cap per source, then take top-k — same trimming
	// discipline as retrieve.ts so one long page can't crowd out other sources.
	const perResource = new Map<string, number>();
	const passages: Passage[] = [];
	for (const item of items) {
		if (passages.length >= topK) break;
		const text = itemText(item);
		if (!text) continue;
		const meta = itemMeta(item);
		// Prefer the real source URL from custom metadata; fall back to the object's
		// own identity so a mis-indexed object still yields a stable (if opaque) key.
		const objectId = item.file_id ?? item.filename ?? item.id ?? item.item?.key ?? '';
		const sourceUrl = readMeta(meta, 'source-url') ?? readMeta(meta, 'url') ?? objectId;
		if (!sourceUrl) continue;

		const resourceId = objectId || sourceUrl;
		const seen = perResource.get(resourceId) ?? 0;
		if (seen >= maxPerResource) continue;
		perResource.set(resourceId, seen + 1);

		passages.push({
			text,
			score: typeof item.score === 'number' ? item.score : 0,
			url: sourceUrl,
			title: readMeta(meta, 'title') ?? null,
			kind: readMeta(meta, 'kind') ?? 'page',
			resourceId,
			chunkIndex: seen
		});
	}

	const sources: Source[] = dedupeSources(passages);
	const context = assembleContext(passages, sources);
	return { passages, sources, context };
}
