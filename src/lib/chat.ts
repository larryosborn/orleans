// Client-safe types shared between the /ask route's server handler and its UI.
// Deliberately NOT imported from `$lib/server/rag/*` — those are server-only
// modules and pulling them into a component would trip SvelteKit's server-only
// guard. The shapes here mirror #37's `Answer` at the serialization seam.

/** The three grounding modes #37's `answer()` can return. */
export type AnswerMode = 'grounded' | 'fallback' | 'abstained';

/** The `ask` action's success payload: a question paired with its answer. This
 *  is the one shape crossing the server→client seam, shared so neither side
 *  hand-rolls it (the server returns it; the page casts `form`/enhance data to
 *  it and renders it). */
export interface AskResult {
	question: string;
	answer: string;
	/** Source URLs — populated only for `grounded` answers. */
	citations: string[];
	mode: AnswerMode;
}

/** One completed exchange in session-scoped history: an `AskResult` plus a
 *  stable id for keyed rendering. */
export interface ChatTurn extends AskResult {
	id: number;
}

/** Human-readable label for a source URL: host + path, trailing slash trimmed. */
export function sourceLabel(url: string): string {
	try {
		const u = new URL(url);
		const path = u.pathname.replace(/\/$/, '');
		return path ? `${u.host}${path}` : u.host;
	} catch {
		return url;
	}
}
