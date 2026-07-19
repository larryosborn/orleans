// Offline fixtures for the eval harness (#39): a tiny hand-written archive plus a
// deterministic "grounding" LLM, so the whole retrieve → answer pipeline can be
// exercised in CI with NO network, NO API key, and NO DATABASE_URL.
//
// Why fixtures and not the real archive: the offline run must be reproducible and
// self-contained. We seed a handful of resources + chunks (embedded with the fake
// hashing embedder from #35) into a throwaway libSQL DB, then drive `retrieve()`
// against it with the SAME fake embedder — exactly the seam the #36 retrieval
// test uses.
//
// The corpus deliberately COVERS the grounded questions (beach stickers, town
// meeting, dogs at Kent's Point, town government) and deliberately OMITS the
// abstain/fallback topics (shellfish fees, election dates, fireworks times,
// zoning) — so the abstention bar is actually tested: the answerer only has real
// records for the questions it should ground, and nothing to lean on for the rest.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, type Client } from '@libsql/client';
import { applyMigrations } from '../../src/lib/server/db/migrator';
import { makeFakeEmbedder, type Embedder } from '../embeddings';
import { makeFakeLlm, type LlmClient } from '../../src/lib/server/rag/llm';
import { SOURCES } from './questions';

export interface FixtureDoc {
	id: string;
	url: string;
	title: string;
	/** 'active' (live, retrievable) | 'gone' (excluded by retrieval's state filter). */
	state: string;
	text: string;
}

// Six live resources: four cover the grounded questions, two (library, transfer
// station) are unrelated filler so retrieval has to actually rank, not just return
// the only thing present.
export const fixtureDocs: FixtureDoc[] = [
	{
		id: 'res-beach',
		url: SOURCES.beach,
		title: 'Beach Stickers & Parking Permits',
		state: 'active',
		text: 'Nauset Beach and Skaket Beach resident parking stickers and beach permits. Residents may purchase an annual beach parking sticker for vehicle parking at the Nauset Beach gate. Apply for your beach parking sticker at the Parks and Beaches department at Town Hall.'
	},
	{
		id: 'res-town-meeting',
		url: SOURCES.townMeeting,
		title: 'Annual Town Meeting',
		state: 'active',
		text: 'The Annual Town Meeting is held each spring at the Nauset Regional Middle School. Registered voters gather at the annual town meeting to vote on the town budget and the warrant articles. A special town meeting may also be called during the year.'
	},
	{
		id: 'res-kents-point',
		url: SOURCES.kentsPoint,
		title: "Kent's Point Conservation Area",
		state: 'active',
		text: "Dogs are allowed at Kent's Point Conservation Area under voice control and off-leash during the off-season. In season, dog owners must leash dogs. Kent's Point rules cover dogs and pets on the conservation trails and the town landing."
	},
	{
		id: 'res-government',
		url: SOURCES.government,
		title: 'Form of Government',
		state: 'active',
		text: 'The Town of Orleans is governed by a five-member Select Board together with a Town Administrator who runs the day-to-day operations. The Select Board sets policy while the Town Administrator manages the departments and staff. This open-town-meeting form of government gives voters the final say.'
	},
	{
		id: 'res-library',
		url: 'https://www.town.orleans.ma.us/snow-library',
		title: 'Snow Library',
		state: 'active',
		text: 'Snow Library offers a summer reading program, museum passes, and childrens story hours. The library is open Tuesday through Saturday and lends books, audiobooks, and digital media to cardholders.'
	},
	{
		id: 'res-transfer-station',
		url: 'https://www.town.orleans.ma.us/transfer-station',
		title: 'Transfer Station & Recycling',
		state: 'active',
		text: 'The Orleans Transfer Station and recycling center accepts household trash and recycling from residents who display a valid disposal sticker on their vehicle. Yard waste and bulky items are handled on posted days.'
	}
];

/**
 * Seed `docs` into a libSQL DB: one resource + one chunk each, embedded with
 * `embedder`. Mirrors the insert shape used by the #36 retrieval test. The caller
 * owns the client (typically a throwaway file/in-memory DB with migrations applied).
 */
export async function seedCorpus(
	client: Client,
	embedder: Embedder,
	docs: FixtureDoc[] = fixtureDocs
): Promise<void> {
	const vectors = await embedder.embed(docs.map((d) => d.text));
	for (let i = 0; i < docs.length; i++) {
		const d = docs[i];
		const u = new URL(d.url);
		await client.execute({
			sql: `INSERT INTO resource (id, url, url_hash, host, path, kind, title, state, priority)
			      VALUES (?, ?, ?, ?, ?, 'page', ?, ?, 1)`,
			args: [d.id, d.url, `h-${d.id}`, u.host, u.pathname, d.title, d.state]
		});
		await client.execute({
			sql: `INSERT INTO chunk (id, resource_id, source_sha, chunk_index, text, char_start, char_end, embedding, embedder, url, title, kind, created_at)
			      VALUES (?, ?, ?, 0, ?, 0, ?, vector32(?), ?, ?, ?, 'page', ?)`,
			args: [
				`chunk-${d.id}`,
				d.id,
				`sha-${d.id}`,
				d.text,
				d.text.length,
				JSON.stringify(vectors[i]),
				embedder.id,
				d.url,
				d.title,
				Date.now()
			]
		});
	}
}

/** A ready-to-query offline fixture DB: a throwaway libSQL file with the real
 *  migrations applied and the fixture corpus seeded (fake embedder). Returns the
 *  client, the embedder used (reuse it so query and chunk vectors match), and a
 *  `cleanup` that closes the client and removes the temp dir. */
export function createFixtureDb(docs: FixtureDoc[] = fixtureDocs): Promise<{
	client: Client;
	embedder: Embedder;
	cleanup: () => void;
}> {
	const drizzleDir = fileURLToPath(new URL('../../drizzle/', import.meta.url));
	const tmp = mkdtempSync(join(tmpdir(), 'rag-eval-'));
	const client = createClient({ url: `file:${join(tmp, 'eval.db')}` });
	const embedder = makeFakeEmbedder();
	const entries = readdirSync(drizzleDir)
		.filter((f) => f.endsWith('.sql'))
		.map((name) => ({ name, sql: readFileSync(join(drizzleDir, name), 'utf8') }));
	return applyMigrations(client, entries)
		.then(() => seedCorpus(client, embedder, docs))
		.then(() => ({
			client,
			embedder,
			cleanup: () => {
				client.close();
				rmSync(tmp, { recursive: true, force: true });
			}
		}));
}

// ---------------------------------------------------------------------------
// Deterministic "grounding" fake LLM.
//
// A real answer model reads the retrieved context and decides grounded /
// fallback / abstained. This fake mimics that decision with a transparent
// lexical rule so CI is reproducible: it measures how well the question's
// content words are covered by the retrieved passages.
//
//   • strong coverage of a passage → grounded, citing that passage's source(s).
//   • weak coverage + an explanatory phrasing ("in general", "how does X work",
//     "why do …") → fallback (labeled general knowledge, no citation).
//   • weak coverage otherwise → abstained (the safe default — never guess a
//     specific the records don't support).
//
// This is not semantic understanding; it's a stand-in that makes the seeded
// corpus design matter and keeps the offline eval honest and deterministic. Swap
// in the real Anthropic client (creds present) for a semantic judgement.
// ---------------------------------------------------------------------------
const STOPWORDS = new Set([
	'the',
	'a',
	'an',
	'and',
	'or',
	'of',
	'to',
	'in',
	'on',
	'at',
	'for',
	'is',
	'are',
	'do',
	'does',
	'did',
	'how',
	'what',
	'when',
	'who',
	'why',
	'will',
	'can',
	'may',
	'be',
	'this',
	'that',
	'it',
	'as',
	'get',
	'you',
	'your',
	'my',
	'i',
	'we',
	'they',
	'them',
	'with',
	'from',
	'year',
	'time',
	'their'
]);

/** Lowercase → alphanumeric tokens → drop stopwords/short tokens → strip a
 *  trailing plural 's', so "permits"/"permit" and "towns"/"town" match. */
function contentWords(text: string): Set<string> {
	const words = new Set<string>();
	for (const raw of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
		if (raw.length < 3 || STOPWORDS.has(raw)) continue;
		words.add(raw.length > 3 && raw.endsWith('s') ? raw.slice(0, -1) : raw);
	}
	return words;
}

/** Fraction of the question's content words present in `text`. */
function coverage(qWords: Set<string>, text: string): number {
	if (qWords.size === 0) return 0;
	const words = contentWords(text);
	let hit = 0;
	for (const w of qWords) if (words.has(w)) hit++;
	return hit / qWords.size;
}

/** Explanatory / contextual phrasing that licenses a labeled fallback answer,
 *  matching the answer-stage policy's "general how does X work / why" wording. */
function isExplanatory(question: string): boolean {
	return /\b(in general|generally|how does|how do .*\bwork|why do|why does|what does .* mean|explain)\b/i.test(
		question
	);
}

interface ParsedPassage {
	text: string;
	url: string;
}

/** Recover (passage text → source url) pairs from the assembled user message so
 *  the fake can cite the specific sources it grounded on. Best-effort: returns []
 *  when nothing was retrieved (context is the empty-corpus placeholder). */
function parsePassages(userMessage: string): ParsedPassage[] {
	// Map citation number → url from the "Sources:" section.
	const urlByNum = new Map<number, string>();
	for (const m of userMessage.matchAll(/^\[(\d+)\]\s+.*?—\s+(\S+)\s*$/gm)) {
		urlByNum.set(Number(m[1]), m[2]);
	}
	// Body passages: "[n] text" spans, before the "Sources:" list. A source-list
	// line also matches "[n] …" but carries an em-dash + url, so skip those.
	const passages: ParsedPassage[] = [];
	for (const m of userMessage.matchAll(/^\[(\d+)\]\s+([\s\S]*?)(?=\n\n\[\d+\]|\n\nSources:|$)/gm)) {
		const num = Number(m[1]);
		const text = m[2].trim();
		if (/—\s+https?:\/\//.test(text)) continue; // this is a Sources: line
		const url = urlByNum.get(num);
		if (url) passages.push({ text, url });
	}
	return passages;
}

/** Pull the question back out of the assembled user message. */
function parseQuestion(userMessage: string): string {
	const m = userMessage.match(/^Question:\s*(.*)$/m);
	return m ? m[1].trim() : '';
}

export interface GroundingFakeOptions {
	/** Min per-passage content-word coverage to treat as grounded. Default 0.5. */
	groundThreshold?: number;
}

/**
 * Build a deterministic grounding LLM. Reads the assembled prompt, scores how well
 * each retrieved passage covers the question, and returns the strict-JSON answer
 * contract answer.ts expects — choosing grounded / fallback / abstained.
 */
export function makeGroundingFakeLlm(opts: GroundingFakeOptions = {}): LlmClient {
	const threshold = opts.groundThreshold ?? 0.5;
	return makeFakeLlm((req) => {
		const user = req.messages.map((m) => m.content).join('\n');
		const question = parseQuestion(user);
		const qWords = contentWords(question);
		const passages = parsePassages(user);

		let best = 0;
		const cited = new Set<string>();
		for (const p of passages) {
			const cov = coverage(qWords, p.text);
			if (cov > best) best = cov;
			if (cov >= threshold) cited.add(p.url);
		}

		if (best >= threshold && cited.size > 0) {
			const supporting = passages.find((p) => coverage(qWords, p.text) >= threshold);
			const snippet = supporting ? firstSentence(supporting.text) : '';
			return JSON.stringify({
				mode: 'grounded',
				answer: `According to the town's records, ${snippet}`,
				citations: [...cited]
			});
		}

		if (isExplanatory(question)) {
			return JSON.stringify({
				mode: 'fallback',
				answer: `In general terms: ${question.replace(/[?.]+$/, '')} depends on the applicable rules; the town's own records don't cover this.`,
				citations: []
			});
		}

		return JSON.stringify({
			mode: 'abstained',
			answer:
				"That specific isn't in the town's records. Check the relevant town department or board, or contact the Town Clerk.",
			citations: []
		});
	}, 'fake-grounding');
}

/** First sentence of a passage, for a plausible grounded answer body. */
function firstSentence(text: string): string {
	const trimmed = text.trim();
	const dot = trimmed.indexOf('. ');
	const s = dot > 0 ? trimmed.slice(0, dot + 1) : trimmed;
	return s.charAt(0).toLowerCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// Deterministic fake AI Search endpoint.
//
// So `RETRIEVAL_PROVIDER=ai-search bun run eval` (and the search() unit path) can
// run fully offline: a `fetch` stand-in that answers the AI Search retrieval REST
// call from the SAME fixture corpus, ranking docs by the same lexical coverage the
// grounding fake uses. Each returned item mirrors the real wire shape — `content`
// parts, a `score`, and the `x-amz-meta-source-url` / `title` / `kind` custom
// metadata the exporter writes — so search.ts's mapping produces real source URLs
// and the eval can compare ai-search vs vectorize head-to-head with no network.
// ---------------------------------------------------------------------------

/** A minimal `fetch`-shaped response the search() provider can read. */
interface FakeResponse {
	ok: boolean;
	status: number;
	json: () => Promise<unknown>;
	text: () => Promise<string>;
}

/**
 * Build a fake AI Search `fetch`. It parses the request body's `query` +
 * `max_num_results`, scores each live fixture doc by content-word coverage, and
 * returns the top matches as AI Search `result.data[]` items with source-url/title/
 * kind metadata. Only `active` docs are eligible (the index never holds dead pages).
 */
export function makeFakeAiSearchFetch(docs: FixtureDoc[] = fixtureDocs) {
	const live = docs.filter((d) => d.state !== 'gone' && d.state !== 'error');
	return async (
		_url: string,
		init?: { method?: string; headers?: Record<string, string>; body?: string }
	): Promise<FakeResponse> => {
		const body = init?.body
			? (JSON.parse(init.body) as { query?: string; max_num_results?: number })
			: {};
		const query = body.query ?? '';
		const limit = Math.max(1, body.max_num_results ?? 8);
		const qWords = contentWords(query);

		const ranked = live
			.map((d) => ({ d, score: coverage(qWords, d.text) }))
			.filter((r) => r.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, limit);

		const data = ranked.map((r) => ({
			file_id: r.d.id,
			filename: `${r.d.id}.md`,
			score: r.score,
			content: [{ type: 'text', text: r.d.text }],
			attributes: {
				'source-url': r.d.url,
				title: r.d.title,
				kind: 'page'
			}
		}));

		return {
			ok: true,
			status: 200,
			json: async () => ({ result: { data }, success: true }),
			text: async () => JSON.stringify({ result: { data }, success: true })
		};
	};
}
