import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { answer } from '$lib/server/rag/answer';
import type { AskResult } from '$lib/chat';

// Gate /ask behind an authenticated session — same guard the dashboard uses
// (src/routes/dashboard/+layout.server.ts). Unauthenticated visitors are bounced
// to /login with a redirect back here.
export const load: PageServerLoad = ({ locals, url }) => {
	if (!locals.user) {
		return redirect(302, `/login?redirect=${encodeURIComponent(url.pathname)}`);
	}
	return { user: locals.user };
};

export const actions: Actions = {
	// Ask one question. Non-streaming for v1: we await the full answer and return
	// it as form data; the page appends it to session-scoped history. Structured so
	// a streaming variant (a +server.ts endpoint) can be added later without
	// changing the UI's turn model.
	ask: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Not authenticated' });

		const data = await request.formData();
		const question = String(data.get('question') ?? '').trim();
		if (!question) return fail(400, { error: 'Ask a question first.', question: '' });

		try {
			const result = await answer(question);
			const payload: AskResult = {
				question,
				answer: result.answer,
				citations: result.citations,
				mode: result.mode
			};
			return payload;
		} catch (err) {
			// The most common failure is a missing ANTHROPIC_API_KEY (selectLlm throws).
			// Surface a friendly message and echo the question back so the user can retry.
			console.error('ask action failed:', err);
			return fail(503, {
				error: 'The answering service is unavailable right now. Please try again in a moment.',
				question
			});
		}
	}
};
