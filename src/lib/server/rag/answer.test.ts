// Answer-generation test (#37). Drives answer() with a DETERMINISTIC fake LLM and
// a fake retrieval fn — no network, no API key, no DB — so all three policy modes
// and the citation invariants are exercised offline (criterion 5). A live smoke
// test against the real Anthropic client runs only when ANTHROPIC_API_KEY is set.
import { describe, it, expect, vi } from 'vitest';
import { answer } from './answer';
import { makeFakeLlm, type LlmClient, type LlmCompletionRequest } from './llm';
import type { RetrievalResult, Source } from './retrieve';

/** A retrieval fn that returns a fixed result and records the question it saw. */
function fakeRetrieval(result: Partial<RetrievalResult>) {
	const sources = (result.sources ?? []) as Source[];
	const full: RetrievalResult = {
		passages: result.passages ?? [],
		sources,
		context:
			result.context ??
			(sources.length
				? `${sources.map((s, i) => `[${i + 1}] passage`).join('\n\n')}\n\nSources:\n${sources
						.map((s, i) => `[${i + 1}] ${s.title ?? s.url} — ${s.url}`)
						.join('\n')}`
				: '')
	};
	return async () => full;
}

const BUDGET: Source = { url: 'https://x/budget', title: 'FY25 Town Budget', kind: 'page' };
const HARBOR: Source = { url: 'https://x/harbor', title: 'Harbor', kind: 'page' };

/** An LLM whose raw output is fixed, but that captures the request for assertions. */
function scriptedLlm(raw: string): {
	llm: LlmClient;
	last: () => LlmCompletionRequest | undefined;
} {
	let seen: LlmCompletionRequest | undefined;
	const llm = makeFakeLlm((req) => {
		seen = req;
		return raw;
	});
	return { llm, last: () => seen };
}

describe('answer', () => {
	it('criterion 1: grounded question cites the correct retrieved source URL', async () => {
		const { llm, last } = scriptedLlm(
			JSON.stringify({
				mode: 'grounded',
				answer: 'The FY25 budget covers harbor dredging permits.',
				citations: ['https://x/budget']
			})
		);
		const result = await answer('What does the budget say about the harbor?', {
			llm,
			retrieve: fakeRetrieval({ sources: [BUDGET] })
		});

		expect(result.mode).toBe('grounded');
		expect(result.citations).toEqual(['https://x/budget']);
		expect(result.answer).toContain('harbor');

		// Grounding wiring: the model got the policy in `system` and the grounded
		// context + URL allow-list in the user message.
		const req = last();
		expect(req?.system).toMatch(/grounded/);
		expect(req?.messages[0].content).toContain('https://x/budget');
		expect(req?.messages[0].content).toContain('What does the budget say');
	});

	it('criterion 4: fabricated citations are dropped; only retrieved URLs survive', async () => {
		const { llm } = scriptedLlm(
			JSON.stringify({
				mode: 'grounded',
				answer: 'Grounded answer.',
				// One real (retrieved) URL, one invented one, plus a duplicate.
				citations: ['https://x/budget', 'https://evil/made-up', 'https://x/budget']
			})
		);
		const result = await answer('q', {
			llm,
			retrieve: fakeRetrieval({ sources: [BUDGET, HARBOR] })
		});

		expect(result.mode).toBe('grounded');
		expect(result.citations).toEqual(['https://x/budget']); // deduped, fabricated removed
		// Whatever comes back is always a subset of what was retrieved.
		const retrieved = new Set(['https://x/budget', 'https://x/harbor']);
		expect(result.citations.every((u) => retrieved.has(u))).toBe(true);
	});

	it('criterion 2: an uncovered context question yields a labeled fallback, no citations', async () => {
		const { llm } = scriptedLlm(
			JSON.stringify({
				mode: 'fallback',
				answer:
					"This is not from the town's records: a select board is the executive body of a New England town.",
				citations: []
			})
		);
		const result = await answer('What is a select board in general?', {
			llm,
			retrieve: fakeRetrieval({ sources: [] })
		});

		expect(result.mode).toBe('fallback');
		expect(result.answer).toMatch(/not from the town's records/i);
		expect(result.citations).toEqual([]);
	});

	it('fallback never carries citations even if the model returns some', async () => {
		const { llm } = scriptedLlm(
			JSON.stringify({
				mode: 'fallback',
				answer: "This is not from the town's records: general background.",
				citations: ['https://x/budget'] // model slipped a citation in
			})
		);
		const result = await answer('q', { llm, retrieve: fakeRetrieval({ sources: [BUDGET] }) });
		expect(result.mode).toBe('fallback');
		expect(result.citations).toEqual([]);
	});

	it("forces the 'not from the town's records' label onto an unlabeled fallback", async () => {
		const { llm } = scriptedLlm(
			JSON.stringify({
				mode: 'fallback',
				answer: 'A select board is the executive body of a New England town.', // no label
				citations: []
			})
		);
		const result = await answer('what is a select board?', {
			llm,
			retrieve: fakeRetrieval({ sources: [] })
		});
		expect(result.mode).toBe('fallback');
		expect(result.answer).toMatch(/^This is not from the town's records:/);
		expect(result.answer).toContain('executive body');
	});

	it('downgrades a grounded answer whose citations were all fabricated to abstained', async () => {
		const { llm } = scriptedLlm(
			JSON.stringify({
				mode: 'grounded',
				answer: 'The fee is $50.', // asserts a specific, but every citation is fake
				citations: ['https://evil/made-up', 'https://also/fake']
			})
		);
		const result = await answer('what is the fee?', {
			llm,
			retrieve: fakeRetrieval({ sources: [BUDGET] })
		});
		// No real source survived → cannot stand behind "grounded"; abstain instead.
		expect(result.mode).toBe('abstained');
		expect(result.citations).toEqual([]);
		expect(result.answer).not.toContain('$50');
	});

	it('criterion 3: a hard specific not in the corpus abstains and points to where to look', async () => {
		const { llm } = scriptedLlm(
			JSON.stringify({
				mode: 'abstained',
				answer:
					"That deadline isn't in the town's records. Check with the Town Clerk or the town website.",
				citations: []
			})
		);
		const result = await answer('What is the deadline to file for a shellfish permit?', {
			llm,
			retrieve: fakeRetrieval({ sources: [] })
		});

		expect(result.mode).toBe('abstained');
		expect(result.citations).toEqual([]);
		// Abstention must not fabricate a specific and should route the asker onward.
		expect(result.answer).toMatch(/isn't in the town's records/i);
		expect(result.answer).toMatch(/clerk|website|department|board/i);
	});

	it('degrades a malformed model response to a safe abstention', async () => {
		const { llm } = scriptedLlm('the model rambled without any JSON at all');
		const result = await answer('q', { llm, retrieve: fakeRetrieval({ sources: [BUDGET] }) });
		expect(result.mode).toBe('abstained');
		expect(result.citations).toEqual([]);
	});

	it('recovers JSON wrapped in prose / code fences', async () => {
		const { llm } = scriptedLlm(
			'Sure!\n```json\n{"mode":"grounded","answer":"ok","citations":["https://x/budget"]}\n```\n'
		);
		const result = await answer('q', { llm, retrieve: fakeRetrieval({ sources: [BUDGET] }) });
		expect(result.mode).toBe('grounded');
		expect(result.citations).toEqual(['https://x/budget']);
	});

	it('an unknown mode degrades to abstained', async () => {
		const { llm } = scriptedLlm(
			JSON.stringify({ mode: 'confident-guess', answer: 'The fee is $50.', citations: [] })
		);
		const result = await answer('q', { llm, retrieve: fakeRetrieval({ sources: [] }) });
		expect(result.mode).toBe('abstained');
	});

	it('short-circuits a blank question to abstained without calling the LLM', async () => {
		const complete = vi.fn(async () => '{}');
		const llm: LlmClient = { id: 'spy', complete };
		const result = await answer('   ', { llm, retrieve: fakeRetrieval({ sources: [BUDGET] }) });
		expect(result.mode).toBe('abstained');
		expect(complete).not.toHaveBeenCalled();
	});
});

// Live smoke test — only runs with a real key. Injects a fake retrieval with a
// known source so it exercises the real Anthropic call + our parsing/enforcement
// without needing a seeded DB. Asserts the contract holds, not exact wording.
describe.runIf(!!process.env.ANTHROPIC_API_KEY)('answer (live smoke)', () => {
	it('produces a valid mode and citations that are a subset of retrieved', async () => {
		const result = await answer('What does the FY25 budget cover about the harbor?', {
			retrieve: fakeRetrieval({
				sources: [BUDGET],
				context:
					'[1] The FY25 town budget funds harbor dredging permits for the fiscal year.\n\nSources:\n[1] FY25 Town Budget — https://x/budget'
			})
		});
		expect(['grounded', 'fallback', 'abstained']).toContain(result.mode);
		const retrieved = new Set(['https://x/budget']);
		expect(result.citations.every((u) => retrieved.has(u))).toBe(true);
	}, 30_000);
});
