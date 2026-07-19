// AI Search retrieval-provider test (#63). Drives search() with a fake `fetch` that
// returns canned AI Search JSON, and proves the mapping: content/score → passages,
// custom `source-url`/`title`/`kind` metadata → real source attribution, sources
// deduped, and a numbered grounded context assembled just like retrieve(). Also
// proves the request shape (endpoint, bearer auth, query/max_num_results body) and
// the per-source cap. Fully offline — no network, no creds.
import { describe, it, expect } from 'vitest';
import { search, type FetchLike } from './search';

/** A fake fetch that records the request and returns a scripted AI Search body. */
function fakeFetch(
	body: unknown,
	capture?: (url: string, init?: Parameters<FetchLike>[1]) => void
): FetchLike {
	return async (url, init) => {
		capture?.(url, init);
		return {
			ok: true,
			status: 200,
			json: async () => body,
			text: async () => JSON.stringify(body)
		};
	};
}

const CFG = { accountId: 'acct-123', instance: 'orleans', token: 'tok-abc' };

const CANNED = {
	result: {
		data: [
			{
				file_id: 'res-beach',
				filename: 'res-beach.md',
				score: 0.91,
				content: [{ type: 'text', text: 'Nauset Beach resident parking stickers.' }],
				attributes: {
					'source-url': 'https://www.town.orleans.ma.us/beach',
					title: 'Beach Stickers',
					kind: 'page'
				}
			},
			{
				file_id: 'res-meeting',
				filename: 'res-meeting.md',
				score: 0.72,
				content: [{ type: 'text', text: 'The Annual Town Meeting is held each spring.' }],
				attributes: {
					'source-url': 'https://www.town.orleans.ma.us/town-meeting',
					title: 'Annual Town Meeting',
					kind: 'page'
				}
			}
		]
	},
	success: true
};

describe('search (AI Search retrieval provider)', () => {
	it('maps content/score + custom metadata into passages with real source URLs', async () => {
		const { passages } = await search('beach stickers', { ...CFG, fetch: fakeFetch(CANNED) });

		expect(passages).toHaveLength(2);
		const top = passages[0];
		expect(top.text).toBe('Nauset Beach resident parking stickers.');
		expect(top.score).toBe(0.91);
		expect(top.url).toBe('https://www.town.orleans.ma.us/beach'); // from x-amz-meta-source-url
		expect(top.title).toBe('Beach Stickers');
		expect(top.kind).toBe('page');
		expect(top.resourceId).toBe('res-beach');
	});

	it('assembles deduped sources + a numbered grounded context (drop-in with retrieve)', async () => {
		const { sources, context } = await search('beach stickers', {
			...CFG,
			fetch: fakeFetch(CANNED)
		});

		expect(sources.map((s) => s.url)).toEqual([
			'https://www.town.orleans.ma.us/beach',
			'https://www.town.orleans.ma.us/town-meeting'
		]);
		expect(context).toContain('[1] Nauset Beach');
		expect(context).toContain('[2] The Annual Town Meeting');
		expect(context).toContain('Sources:');
		expect(context).toContain('Beach Stickers — https://www.town.orleans.ma.us/beach');
	});

	it('calls the retrieval-only REST endpoint with bearer auth + query body', async () => {
		let seenUrl = '';
		let seenInit: Parameters<FetchLike>[1];
		await search('dogs at kents point', {
			...CFG,
			topK: 5,
			fetch: fakeFetch(CANNED, (url, init) => {
				seenUrl = url;
				seenInit = init;
			})
		});

		// retrieval-only `/search`, NOT the generative `/ai-search`.
		expect(seenUrl).toBe(
			'https://api.cloudflare.com/client/v4/accounts/acct-123/ai-search/instances/orleans/search'
		);
		expect(seenInit?.method).toBe('POST');
		expect(seenInit?.headers?.authorization).toBe('Bearer tok-abc');
		const body = JSON.parse(seenInit?.body ?? '{}');
		expect(body.query).toBe('dogs at kents point');
		expect(body.max_num_results).toBe(5);
	});

	it('reads the alternate chunks[]/text + item.metadata wire shape too', async () => {
		const alt = {
			result: {
				chunks: [
					{
						id: 'res-x',
						score: 0.5,
						text: 'flat text form',
						item: {
							key: 'res-x.md',
							metadata: { 'source-url': 'https://x/y', title: 'X', kind: 'document' }
						}
					}
				]
			}
		};
		const { passages } = await search('q', { ...CFG, fetch: fakeFetch(alt) });
		expect(passages).toHaveLength(1);
		expect(passages[0].text).toBe('flat text form');
		expect(passages[0].url).toBe('https://x/y');
		expect(passages[0].kind).toBe('document');
	});

	it('caps passages per source document', async () => {
		const dupey = {
			result: {
				data: [0, 1, 2].map((i) => ({
					file_id: 'res-same',
					score: 1 - i * 0.1,
					content: [{ type: 'text', text: `chunk ${i}` }],
					attributes: { 'source-url': 'https://x/same', title: 'Same', kind: 'page' }
				}))
			}
		};
		const { passages } = await search('q', { ...CFG, maxPerResource: 2, fetch: fakeFetch(dupey) });
		expect(passages).toHaveLength(2); // 3 candidates from one source, capped to 2
	});

	it('returns empty for a blank question without calling fetch', async () => {
		let called = false;
		const result = await search('   ', {
			...CFG,
			fetch: fakeFetch(CANNED, () => {
				called = true;
			})
		});
		expect(called).toBe(false);
		expect(result).toEqual({ passages: [], sources: [], context: '' });
	});

	it('throws a pointed error when config is missing', async () => {
		await expect(search('q', { fetch: fakeFetch(CANNED) })).rejects.toThrow(/CF_ACCOUNT_ID/);
	});

	it('surfaces a non-ok response as an error', async () => {
		const failing: FetchLike = async () => ({
			ok: false,
			status: 403,
			json: async () => ({}),
			text: async () => 'forbidden'
		});
		await expect(search('q', { ...CFG, fetch: failing })).rejects.toThrow(/403/);
	});
});
