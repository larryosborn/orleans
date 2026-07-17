// The eval engine (#39): runs a question set through retrieval + answer and
// scores three things the RAG epic (#32) cares about —
//
//   • retrieval hit-rate — for questions that name an expected source, did that
//     source actually surface in retrieval? (Is the right document findable?)
//   • mode-correctness   — did the answerer choose the expected mode? i.e. did it
//     ground when the archive covers the question AND abstain when it doesn't.
//   • citation-validity  — is every cited URL one that retrieval actually returned?
//     (#37 enforces this, so a failure here is a real regression.)
//
// The engine is pure and injectable: it takes `retrieve`/`answer` functions plus
// their options, so the offline runner wires in a seeded DB + fakes and a real
// run wires in the live DB + real models — the scoring code is identical either way.
import type { RetrievalResult, RetrieveOptions } from '../../src/lib/server/rag/retrieve';
import type { Answer, AnswerMode, AnswerOptions } from '../../src/lib/server/rag/answer';
import type { EvalQuestion } from './questions';

export interface EvalOutcome {
	question: string;
	expectedMode: AnswerMode;
	actualMode: AnswerMode;
	modeCorrect: boolean;
	/** null when the question names no expected source (not part of hit-rate). */
	expectedSource?: string;
	retrievalHit: boolean | null;
	citations: string[];
	citationValid: boolean;
	retrievedUrls: string[];
	answer: string;
	note?: string;
}

export interface EvalMetrics {
	total: number;
	/** Retrieval hit-rate over questions that declare an expected source. */
	retrievalHitRate: number;
	retrievalHits: number;
	retrievalEligible: number;
	/** Fraction of questions whose answer mode matched expectation. */
	modeCorrectness: number;
	modeCorrect: number;
	/** Fraction of questions whose citations were all genuinely retrieved. */
	citationValidity: number;
	citationValid: number;
	/** Per-expected-mode correctness, so abstention can be read separately. */
	byMode: Record<AnswerMode, { total: number; correct: number }>;
}

export interface EvalReport {
	outcomes: EvalOutcome[];
	metrics: EvalMetrics;
}

export interface RunEvalDeps {
	retrieve: (question: string, opts?: RetrieveOptions) => Promise<RetrievalResult>;
	answer: (question: string, opts?: AnswerOptions) => Promise<Answer>;
	/** Retrieval knobs (injected client/embedder, topK) — shared by both calls so
	 *  the hit-rate we measure is the same retrieval the answerer grounded on. */
	retrieveOptions?: RetrieveOptions;
	/** Answer knobs (injected llm, model). `retrieveOptions` is forwarded for you. */
	answerOptions?: Omit<AnswerOptions, 'retrieveOptions'>;
}

/** Run the whole question set, scoring each question. Deterministic given
 *  deterministic deps (fake embedder + fake LLM). */
export async function runEval(questions: EvalQuestion[], deps: RunEvalDeps): Promise<EvalReport> {
	const outcomes: EvalOutcome[] = [];
	for (const q of questions) {
		// One retrieval for the hit-rate metric; the answerer runs its own retrieval
		// with the SAME options, so — being deterministic — it grounds on the same set.
		const retrieval = await deps.retrieve(q.question, deps.retrieveOptions);
		const retrievedUrls = retrieval.sources.map((s) => s.url);
		const a = await deps.answer(q.question, {
			...deps.answerOptions,
			retrieveOptions: deps.retrieveOptions
		});

		const retrievalHit = q.expectedSource ? retrievedUrls.includes(q.expectedSource) : null;
		const citationValid = a.citations.every((c) => retrievedUrls.includes(c));

		outcomes.push({
			question: q.question,
			expectedMode: q.expectedMode,
			actualMode: a.mode,
			modeCorrect: a.mode === q.expectedMode,
			expectedSource: q.expectedSource,
			retrievalHit,
			citations: a.citations,
			citationValid,
			retrievedUrls,
			answer: a.answer,
			note: q.note
		});
	}
	return { outcomes, metrics: computeMetrics(outcomes) };
}

export function computeMetrics(outcomes: EvalOutcome[]): EvalMetrics {
	const total = outcomes.length;
	const eligible = outcomes.filter((o) => o.retrievalHit !== null);
	const retrievalHits = eligible.filter((o) => o.retrievalHit === true).length;
	const modeCorrect = outcomes.filter((o) => o.modeCorrect).length;
	const citationValid = outcomes.filter((o) => o.citationValid).length;

	const byMode = { grounded: z(), fallback: z(), abstained: z() } as EvalMetrics['byMode'];
	for (const o of outcomes) {
		byMode[o.expectedMode].total++;
		if (o.modeCorrect) byMode[o.expectedMode].correct++;
	}

	return {
		total,
		retrievalEligible: eligible.length,
		retrievalHits,
		retrievalHitRate: eligible.length ? retrievalHits / eligible.length : NaN,
		modeCorrect,
		modeCorrectness: total ? modeCorrect / total : NaN,
		citationValid,
		citationValidity: total ? citationValid / total : NaN,
		byMode
	};
}

function z(): { total: number; correct: number } {
	return { total: 0, correct: 0 };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
const pct = (n: number): string => (Number.isNaN(n) ? 'n/a' : `${(n * 100).toFixed(0)}%`);

function modeTag(o: EvalOutcome): string {
	if (o.modeCorrect) return `${o.actualMode}`;
	return `${o.actualMode} (want ${o.expectedMode})`;
}

function hitTag(o: EvalOutcome): string {
	if (o.retrievalHit === null) return '—';
	return o.retrievalHit ? 'hit' : 'MISS';
}

/** A readable per-question + aggregate plain-text report for the terminal. */
export function formatReport(report: EvalReport, title = 'RAG eval'): string {
	const { outcomes, metrics } = report;
	const lines: string[] = [];
	lines.push(`\n${title} — ${outcomes.length} questions`);
	lines.push('─'.repeat(72));
	for (const o of outcomes) {
		const ok = o.modeCorrect && o.citationValid && o.retrievalHit !== false;
		lines.push(`${ok ? '✓' : '✗'} ${o.question}`);
		lines.push(
			`    mode: ${modeTag(o)}   retrieval: ${hitTag(o)}   citations: ${
				o.citationValid ? `${o.citations.length} valid` : 'INVALID'
			}`
		);
	}
	lines.push('─'.repeat(72));
	lines.push(
		`retrieval hit-rate:   ${pct(metrics.retrievalHitRate)}  (${metrics.retrievalHits}/${metrics.retrievalEligible} sourced questions)`
	);
	lines.push(
		`mode-correctness:     ${pct(metrics.modeCorrectness)}  (${metrics.modeCorrect}/${metrics.total})`
	);
	lines.push(
		`citation-validity:    ${pct(metrics.citationValidity)}  (${metrics.citationValid}/${metrics.total})`
	);
	lines.push('by expected mode:');
	for (const mode of ['grounded', 'fallback', 'abstained'] as AnswerMode[]) {
		const m = metrics.byMode[mode];
		if (m.total) lines.push(`    ${mode.padEnd(10)} ${m.correct}/${m.total}`);
	}
	return lines.join('\n');
}

/** The same report as Markdown (for `--markdown` / CI artifacts). */
export function formatMarkdown(report: EvalReport, title = 'RAG eval'): string {
	const { outcomes, metrics } = report;
	const rows = outcomes
		.map((o) => {
			const ok = o.modeCorrect && o.citationValid && o.retrievalHit !== false;
			return `| ${ok ? '✅' : '❌'} | ${o.question.replace(/\|/g, '\\|')} | ${o.expectedMode} | ${o.actualMode} | ${hitTag(o)} | ${o.citationValid ? o.citations.length : 'INVALID'} |`;
		})
		.join('\n');
	return [
		`## ${title}`,
		'',
		`- **Retrieval hit-rate:** ${pct(metrics.retrievalHitRate)} (${metrics.retrievalHits}/${metrics.retrievalEligible})`,
		`- **Mode-correctness:** ${pct(metrics.modeCorrectness)} (${metrics.modeCorrect}/${metrics.total})`,
		`- **Citation-validity:** ${pct(metrics.citationValidity)} (${metrics.citationValid}/${metrics.total})`,
		'',
		'| | Question | Expected | Actual | Retrieval | Citations |',
		'| - | --- | --- | --- | --- | --- |',
		rows
	].join('\n');
}
