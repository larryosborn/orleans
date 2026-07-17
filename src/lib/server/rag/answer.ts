// Answer generation — stage 4 of the RAG pipeline (#37). The GENERATION side:
// given a question it uses #36's `retrieve()` to build grounded context, then
// asks Claude for an answer that follows the grounding policy grilled out in #32.
//
// THE POLICY (three modes, faithfully implemented):
//   • grounded  — the corpus covers it: answer from the retrieved passages and
//                 cite the source URL(s) actually used.
//   • fallback  — a CONTEXT/explanatory question the corpus doesn't cover: a
//                 general-knowledge answer is allowed, but it MUST be labeled
//                 "not from the town's records" and carries NO citations.
//   • abstained — a HARD SPECIFIC not supported by context (a date, deadline,
//                 fee, legal rule, or who holds an office): do NOT guess — say it
//                 isn't in the town's records and point to where to look.
//
// Four invariants the code enforces regardless of what the model returns, so a
// hallucinating model can't break the contract (the prompt asks for these; the
// code guarantees them):
//   • Citations are ALWAYS a subset of what was retrieved — we intersect the
//     model's cited URLs with `sources`, dropping anything fabricated (criterion
//     4). Only `grounded` answers carry citations; fallback/abstained carry none.
//   • A `grounded` answer must keep at least one real (retrieved) citation — if
//     every cited URL was fabricated and gets dropped, we can't stand behind the
//     "grounded" claim, so it degrades to `abstained`.
//   • A `fallback` answer is ALWAYS prefixed with the "not from the town's
//     records" label, whether or not the model remembered to add it.
//   • Mode is validated to the three-value enum; anything else degrades to
//     `abstained` (the safe default — never assert an unsupported specific).
import {
	retrieve as defaultRetrieve,
	type RetrievalResult,
	type RetrieveOptions
} from './retrieve';
import {
	selectLlm,
	defaultAnswerModel,
	DEFAULT_MAX_TOKENS,
	type LlmClient,
	type LlmCompletionRequest
} from './llm';

export type AnswerMode = 'grounded' | 'fallback' | 'abstained';

/** A grounded, policy-compliant answer. */
export interface Answer {
	answer: string;
	/** Source URLs actually used — always a subset of what retrieval returned.
	 *  Non-empty only for `grounded` answers. */
	citations: string[];
	mode: AnswerMode;
}

export interface AnswerOptions {
	/** Inject an LLM client (tests / explicit config). Defaults to `selectLlm()`. */
	llm?: LlmClient;
	/** Model id. Defaults to `defaultAnswerModel()` (RAG_ANSWER_MODEL / Haiku). */
	model?: string;
	/** Output cap passed to the model. Defaults to `DEFAULT_MAX_TOKENS`. */
	maxTokens?: number;
	/** Inject a retrieval fn (tests / seeded corpus). Defaults to #36's `retrieve()`. */
	retrieve?: (question: string, opts?: RetrieveOptions) => Promise<RetrievalResult>;
	/** Options forwarded to the retrieval fn (topK, injected client/embedder, …). */
	retrieveOptions?: RetrieveOptions;
}

/**
 * Answer `question`: retrieve grounded context, ask the model under the grounding
 * policy, then enforce the citation/mode invariants on the result.
 *
 * A blank question short-circuits to an abstention (nothing to ground on).
 */
export async function answer(question: string, opts: AnswerOptions = {}): Promise<Answer> {
	if (!question.trim()) return abstention();

	// Select the LLM up front so a missing ANTHROPIC_API_KEY fails fast, before we
	// spend an embed + vector query on retrieval we'd then throw away.
	const llm = selectLlm(opts.llm);

	const retrieveFn = opts.retrieve ?? defaultRetrieve;
	const retrieval = await retrieveFn(question, opts.retrieveOptions);
	const retrievedUrls = retrieval.sources.map((s) => s.url);

	const req: LlmCompletionRequest = {
		system: SYSTEM_PROMPT,
		messages: [{ role: 'user', content: buildUserMessage(question, retrieval) }],
		model: opts.model ?? defaultAnswerModel(),
		maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS
	};

	const raw = await llm.complete(req);
	return normalize(raw, retrievedUrls);
}

// The policy, encoded once. The model must return STRICT JSON matching the
// contract below — we parse structure out of the text rather than relying on a
// provider-specific structured-output feature, so the seam stays string-shaped
// and every model (and the fake) speaks the same protocol.
const SYSTEM_PROMPT = `You answer questions about the Town of Orleans using ONLY the town's own archived records, which are supplied to you as retrieved context. You are precise and you never invent civic facts.

Decide one of three modes for each question:

1. "grounded" — The retrieved context supports an answer. Answer from the context and cite the source URL(s) you actually used. Cite ONLY URLs listed under "Available source URLs"; never cite anything else.

2. "fallback" — The question is explanatory or contextual (background, general "how does X work" / "why", definitions) and the retrieved context does NOT cover it. You may answer from general knowledge, but you MUST clearly label it as not coming from the town's records — begin the answer with "This is not from the town's records:". Do not cite any sources.

3. "abstained" — The question asks for a HARD, SPECIFIC civic fact — a date, deadline, fee or dollar amount, legal rule or requirement, or who currently holds an office — and the retrieved context does NOT support it. Do NOT guess or state any specific figure, date, or name. Say it isn't in the town's records and point the person to where to look (e.g. the relevant town department, board, or the town website/clerk). Do not cite any sources.

When in doubt between fallback and abstained for a specific civic fact you can't ground, choose "abstained" — never fabricate a specific.

Respond with a single JSON object and nothing else:
{"mode": "grounded" | "fallback" | "abstained", "answer": "<your answer as a string>", "citations": ["<source url>", ...]}
"citations" must be an array of source URLs drawn only from the provided list (empty for fallback and abstained).`;

/** Assemble the question + grounded context + the explicit allow-list of URLs. */
function buildUserMessage(question: string, retrieval: RetrievalResult): string {
	const context = retrieval.context.trim() || "(nothing was retrieved from the town's records)";
	const urls =
		retrieval.sources.length > 0 ? retrieval.sources.map((s) => `- ${s.url}`).join('\n') : '(none)';
	return `Question: ${question}

Retrieved context from the town's records:
${context}

Available source URLs (cite only these, verbatim):
${urls}`;
}

/** The label a fallback answer must carry — general knowledge, not town records. */
const FALLBACK_LABEL = "This is not from the town's records:";

/** The canned abstention: says it isn't in the records AND points onward — used
 *  for blank/malformed/ungroundable cases so the "where to look" pointer (the
 *  policy's requirement) holds even when we don't have the model's own wording. */
function abstention(): Answer {
	return {
		answer:
			"That isn't in the town's records. Try the relevant town department or board, or the town website / clerk.",
		citations: [],
		mode: 'abstained'
	};
}

/**
 * Enforce the contract on the model's raw output: parse the JSON, validate the
 * mode, intersect citations with what was actually retrieved, require a real
 * citation to stay `grounded`, and force the fallback label. A malformed or empty
 * response degrades to a safe abstention rather than surfacing garbage.
 */
function normalize(raw: string, retrievedUrls: string[]): Answer {
	const parsed = parseJsonObject(raw);
	if (!parsed) return abstention();

	const mode: AnswerMode =
		parsed.mode === 'grounded' || parsed.mode === 'fallback' ? parsed.mode : 'abstained';

	// Empty/malformed answer text → canned abstention (which points onward).
	const answerText = typeof parsed.answer === 'string' ? parsed.answer.trim() : '';
	if (!answerText) return abstention();

	// Abstained: keep the model's own answer (it usually names where to look);
	// never carries citations.
	if (mode === 'abstained') return { answer: answerText, citations: [], mode: 'abstained' };

	if (mode === 'fallback') {
		// Guarantee the label regardless of whether the model added it.
		const labeled = /not from the town's records/i.test(answerText)
			? answerText
			: `${FALLBACK_LABEL} ${answerText}`;
		return { answer: labeled, citations: [], mode: 'fallback' };
	}

	// grounded: keep only URLs that were truly retrieved — the hard guarantee
	// against fabricated citations.
	const allowed = new Set(retrievedUrls);
	const citations = [
		...new Set(
			(Array.isArray(parsed.citations) ? parsed.citations : []).filter(
				(u): u is string => typeof u === 'string' && allowed.has(u)
			)
		)
	];
	// A "grounded" claim with no surviving real citation is untrustworthy — every
	// cited URL was fabricated — so we can't stand behind it. Abstain instead.
	if (citations.length === 0) return abstention();

	return { answer: answerText, citations, mode: 'grounded' };
}

interface RawAnswer {
	mode?: unknown;
	answer?: unknown;
	citations?: unknown;
}

/** Tolerant JSON extraction: parse the whole string, else the first {...} span.
 *  Models occasionally wrap JSON in prose or code fences; this recovers it. */
function parseJsonObject(raw: string): RawAnswer | null {
	const attempt = (s: string): RawAnswer | null => {
		try {
			const v = JSON.parse(s);
			return v && typeof v === 'object' ? (v as RawAnswer) : null;
		} catch {
			return null;
		}
	};
	const whole = attempt(raw.trim());
	if (whole) return whole;
	const start = raw.indexOf('{');
	const end = raw.lastIndexOf('}');
	if (start >= 0 && end > start) return attempt(raw.slice(start, end + 1));
	return null;
}
