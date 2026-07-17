// Eval-harness test (#39). Applies the REAL drizzle migrations to a throwaway
// libSQL DB, seeds the fixture corpus with the deterministic fake embedder, then
// runs the full question set through retrieve() + answer() with the fake grounding
// LLM. Proves the harness computes retrieval hit-rate, mode-correctness, and
// citation-validity — and, crucially, that a should-abstain question actually
// scores abstained and a grounded one scores grounded+cited. All offline: no
// network, no DATABASE_URL, no API key.
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { retrieve } from '../../src/lib/server/rag/retrieve';
import { answer } from '../../src/lib/server/rag/answer';
import { questions } from './questions';
import { createFixtureDb, makeGroundingFakeLlm } from './corpus';
import { runEval, computeMetrics, formatReport, type EvalReport } from './harness';

let cleanup: () => void;
let report: EvalReport;

beforeAll(async () => {
	const fixture = await createFixtureDb();
	cleanup = fixture.cleanup;
	report = await runEval(questions, {
		retrieve,
		answer,
		retrieveOptions: { client: fixture.client, embedder: fixture.embedder, topK: 4 },
		answerOptions: { llm: makeGroundingFakeLlm() }
	});
});

afterAll(() => {
	cleanup?.();
});

describe('eval harness', () => {
	it('scores every question in the set', () => {
		expect(report.outcomes).toHaveLength(questions.length);
		// The set spans all three expected modes — grounding AND abstention are tested.
		const modes = new Set(questions.map((q) => q.expectedMode));
		expect(modes).toEqual(new Set(['grounded', 'abstained', 'fallback']));
	});

	it('computes the three headline metrics as fractions in [0,1]', () => {
		const m = report.metrics;
		for (const v of [m.retrievalHitRate, m.modeCorrectness, m.citationValidity]) {
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThanOrEqual(1);
		}
		expect(m.total).toBe(questions.length);
		expect(m.retrievalEligible).toBeGreaterThan(0);
	});

	it('every cited URL was actually retrieved (citation-validity holds)', () => {
		// The hard #37 invariant — a failure here is a real regression.
		expect(report.metrics.citationValidity).toBe(1);
		for (const o of report.outcomes) {
			for (const c of o.citations) expect(o.retrievedUrls).toContain(c);
		}
	});

	it('a grounded question answers grounded, cited, and retrieves its source', () => {
		const o = report.outcomes.find((x) => x.question.includes('beach parking sticker'));
		expect(o).toBeDefined();
		expect(o!.actualMode).toBe('grounded');
		expect(o!.citations.length).toBeGreaterThan(0);
		expect(o!.retrievalHit).toBe(true);
	});

	it('a should-abstain hard-specific question actually abstains', () => {
		// The abstention bar: a fee the archive does not cover must NOT be answered.
		const o = report.outcomes.find((x) => x.question.includes('shellfish permit'));
		expect(o).toBeDefined();
		expect(o!.expectedMode).toBe('abstained');
		expect(o!.actualMode).toBe('abstained');
		expect(o!.citations).toEqual([]);
	});

	it('an explanatory question falls back with a labeled, uncited answer', () => {
		const o = report.outcomes.find((x) => x.question.includes('coastal towns'));
		expect(o).toBeDefined();
		expect(o!.actualMode).toBe('fallback');
		expect(o!.citations).toEqual([]);
		expect(o!.answer.toLowerCase()).toContain("not from the town's records");
	});

	it('grounded and abstained cohorts are both fully correct offline', () => {
		// Deterministic fixtures → the fake pipeline nails these two cohorts, which
		// is what guards the accuracy/abstention bar in CI.
		const { byMode } = report.metrics;
		expect(byMode.grounded.correct).toBe(byMode.grounded.total);
		expect(byMode.abstained.correct).toBe(byMode.abstained.total);
	});

	it('formatReport renders per-question lines and the aggregate metrics', () => {
		const text = formatReport(report);
		expect(text).toContain('retrieval hit-rate:');
		expect(text).toContain('mode-correctness:');
		expect(text).toContain('citation-validity:');
		expect(text).toContain(questions[0].question);
	});

	it('computeMetrics counts hit-rate only over questions with an expected source', () => {
		const m = computeMetrics([
			{
				question: 'q1',
				expectedMode: 'grounded',
				actualMode: 'grounded',
				modeCorrect: true,
				expectedSource: 'https://x/a',
				retrievalHit: true,
				citations: ['https://x/a'],
				citationValid: true,
				retrievedUrls: ['https://x/a'],
				answer: 'a'
			},
			{
				question: 'q2',
				expectedMode: 'abstained',
				actualMode: 'abstained',
				modeCorrect: true,
				retrievalHit: null,
				citations: [],
				citationValid: true,
				retrievedUrls: [],
				answer: 'b'
			}
		]);
		expect(m.retrievalEligible).toBe(1);
		expect(m.retrievalHitRate).toBe(1);
		expect(m.modeCorrectness).toBe(1);
	});
});
