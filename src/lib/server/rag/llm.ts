// LLM client — the generation seam for the RAG answer stage (#37). A tiny
// interface behind which the actual model lives, exactly mirroring the embedding
// seam (worker/embeddings.ts → selectEmbedder): the answerer (answer.ts) never
// names a provider — it asks `selectLlm()` for an `LlmClient` and calls
// `.complete(req)`. Swapping models/providers is config (ANTHROPIC_API_KEY /
// RAG_ANSWER_MODEL), not a code change, and tests inject a deterministic fake.
//
// Deliberately string-in / string-out. Grounding, citation policy, and the
// JSON answer contract all live in answer.ts; keeping the transport dumb makes
// the fake trivial to script and keeps this module provider-shaped, not
// policy-shaped. Non-streaming for now — #38's chat UI can add a `stream()`
// method to `LlmClient` without touching the answer policy.
import Anthropic from '@anthropic-ai/sdk';

/** A single conversational turn handed to the model. */
export interface LlmMessage {
	role: 'user' | 'assistant';
	content: string;
}

/** A non-streaming completion request. `system` carries the grounding policy;
 *  `messages` carries the grounded context + question. */
export interface LlmCompletionRequest {
	system: string;
	messages: LlmMessage[];
	/** Model id (e.g. `claude-haiku-4-5`). Chosen by the caller so cost/quality
	 *  is a per-call decision, not baked into the client. */
	model: string;
	/** Output cap. Defaults to `DEFAULT_MAX_TOKENS`. */
	maxTokens?: number;
}

/** The generation seam. `complete` returns the model's text output (all text
 *  blocks concatenated); the answerer parses structure out of it. */
export interface LlmClient {
	/** Provenance id (e.g. `anthropic`, `fake`) — handy in logs/tests. */
	readonly id: string;
	complete(req: LlmCompletionRequest): Promise<string>;
}

/** Small/cheap default — the answer stage is a short, grounded generation, so a
 *  Haiku-class model is the right cost point. Overridable via RAG_ANSWER_MODEL. */
export const DEFAULT_ANSWER_MODEL = 'claude-haiku-4-5';
/** Escalation target for when a call wants more headroom (harder synthesis).
 *  Not auto-selected here — exposed so callers/config can opt in. */
export const DEFAULT_ESCALATION_MODEL = 'claude-sonnet-5';
/** Generous cap for a single grounded answer; JSON payload is small. */
export const DEFAULT_MAX_TOKENS = 1024;

/** The configured default answer model: RAG_ANSWER_MODEL or the cheap default. */
export function defaultAnswerModel(): string {
	return process.env.RAG_ANSWER_MODEL?.trim() || DEFAULT_ANSWER_MODEL;
}

/** The configured escalation model: RAG_ANSWER_ESCALATION_MODEL or the default. */
export function escalationModel(): string {
	return process.env.RAG_ANSWER_ESCALATION_MODEL?.trim() || DEFAULT_ESCALATION_MODEL;
}

// ---------------------------------------------------------------------------
// Anthropic (real). Needs ANTHROPIC_API_KEY. Non-streaming; no thinking/effort
// params so the same call shape works across Haiku 4.5 / Sonnet / Opus (Haiku
// 4.5 rejects `effort` and adaptive thinking — see the claude-api skill).
// ---------------------------------------------------------------------------
export function makeAnthropicLlm(opts?: { apiKey?: string }): LlmClient {
	const apiKey = opts?.apiKey ?? process.env.ANTHROPIC_API_KEY;
	if (!apiKey) throw new Error('anthropic llm needs ANTHROPIC_API_KEY');
	const client = new Anthropic({ apiKey });
	return {
		id: 'anthropic',
		async complete(req) {
			const res = await client.messages.create({
				model: req.model,
				max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
				system: req.system,
				messages: req.messages.map((m) => ({ role: m.role, content: m.content }))
			});
			return res.content
				.filter((b): b is Anthropic.TextBlock => b.type === 'text')
				.map((b) => b.text)
				.join('');
		}
	};
}

// ---------------------------------------------------------------------------
// Fake (offline / tests). A scripted responder — you supply a function that maps
// a request to the raw completion string, so a test can drive each answer mode
// deterministically without a network or an API key. Mirrors makeFakeEmbedder.
// ---------------------------------------------------------------------------
export type FakeLlmHandler = (req: LlmCompletionRequest) => string;

export function makeFakeLlm(handler: FakeLlmHandler, id = 'fake'): LlmClient {
	return {
		id,
		async complete(req) {
			return handler(req);
		}
	};
}

/**
 * Pick an LLM client: an injected one (tests / explicit config) wins; otherwise
 * the real Anthropic client when ANTHROPIC_API_KEY is set. Throws if neither is
 * available — the answerer should never silently no-op.
 */
export function selectLlm(injected?: LlmClient): LlmClient {
	if (injected) return injected;
	if (process.env.ANTHROPIC_API_KEY) return makeAnthropicLlm();
	throw new Error(
		'no LLM configured: set ANTHROPIC_API_KEY or pass an injected LlmClient (opts.llm)'
	);
}
