// Boilerplate / low-signal chunk filter (#59). Nav-heavy CivicPlus landing and
// index pages leak menu/chrome through readability extraction — e.g. the menu
// strip "Government Community Business Visiting Orleans How Do I…", contact-info
// footers, calendar grids, and link lists. Chunked and embedded, those near-
// identical low-signal snippets recur across many resources and pollute the
// vector index (they match everything and mean nothing).
//
// The discriminator is CONTENT DENSITY, measured as function-word (stopword)
// ratio: the fraction of word tokens that are common English function words
// (the/of/to/and/is/…). Genuine prose — FAQ answers, policy text, news — is
// always rich in function words (~0.25–0.50 on the real Orleans corpus). Nav
// menus, label lists, form fields, and number grids are noun/label salads with
// almost none (~0.00–0.18). A single tunable floor cleanly separates the two.
//
// Filtering happens at chunk time (worker/embed.ts), BEFORE chunks are embedded
// and written to `chunk`, so the raw `resource_text` stays intact — the filter
// only decides which chunks reach the index, never mutates the extracted text.
import { CHUNK_MIN_STOPWORD_RATIO } from './config';

// A compact, standard English function-word list. Function words carry grammar,
// not topic, so real sentences are dense with them while nav/label chrome is not
// — which is exactly what makes their density a robust content signal. Lowercase;
// matched against alphanumeric word tokens.
// prettier-ignore
export const STOPWORDS: ReadonlySet<string> = new Set([
	'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and',
	'any', 'are', 'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below',
	'between', 'both', 'but', 'by', 'can', 'could', 'did', 'do', 'does', 'doing',
	'down', 'during', 'each', 'few', 'for', 'from', 'further', 'had', 'has', 'have',
	'having', 'he', 'her', 'here', 'hers', 'herself', 'him', 'himself', 'his', 'how',
	'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'just', 'me', 'might',
	'more', 'most', 'must', 'my', 'myself', 'no', 'nor', 'not', 'now', 'of', 'off',
	'on', 'once', 'only', 'or', 'other', 'our', 'ours', 'out', 'over', 'own', 'said',
	'same', 'shall', 'she', 'should', 'so', 'some', 'such', 'than', 'that', 'the',
	'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they', 'this',
	'those', 'through', 'to', 'too', 'under', 'until', 'up', 'upon', 'us', 'very',
	'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom',
	'why', 'will', 'with', 'would', 'you', 'your', 'yours', 'yourself'
]);

/** Word tokens (alphanumeric runs, Unicode-aware) used to measure density. */
function words(text: string): string[] {
	return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Content density of a chunk: the fraction of its word tokens that are English
 * function words, in [0, 1]. High for prose, near-zero for nav/label/link/number
 * chrome. Empty / word-free text scores 0 (treated as no content).
 */
export function stopwordRatio(text: string): number {
	const toks = words(text);
	if (toks.length === 0) return 0;
	let stop = 0;
	for (const t of toks) if (STOPWORDS.has(t)) stop++;
	return stop / toks.length;
}

/**
 * True when a chunk is low-signal boilerplate (nav/menu/link-list/form/number
 * chrome) and should be kept OUT of the vector index. A chunk qualifies when its
 * content density (stopword ratio) is below `minRatio`.
 *
 * `minRatio` defaults to the configured CHUNK_MIN_STOPWORD_RATIO. A value of 0
 * disables the filter (nothing is boilerplate) — the escape hatch for turning it
 * off entirely via config.
 */
export function isBoilerplateChunk(
	text: string,
	minRatio: number = CHUNK_MIN_STOPWORD_RATIO
): boolean {
	if (minRatio <= 0) return false; // filter disabled
	return stopwordRatio(text) < minRatio;
}
