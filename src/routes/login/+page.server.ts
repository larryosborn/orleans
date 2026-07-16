import { fail, redirect } from '@sveltejs/kit';
import type { Actions } from './$types';
import type { PageServerLoad } from './$types';
import { auth } from '$lib/server/auth';
import { APIError } from 'better-auth/api';

// Only honor same-origin relative paths from `?redirect=`; anything else falls
// back to the account page so the param can't be used for open redirects.
function safeRedirect(url: URL): string {
	const target = url.searchParams.get('redirect');
	if (target && target.startsWith('/') && !target.startsWith('//')) {
		return target;
	}
	return '/account';
}

export const load: PageServerLoad = (event) => {
	if (event.locals.user) {
		return redirect(302, safeRedirect(event.url));
	}
	// Surfaced to the page so the form can carry `redirect` through the POST,
	// which would otherwise drop the query string when posting to `?/action`.
	return { redirectTo: safeRedirect(event.url) };
};

export const actions: Actions = {
	signInEmail: async (event) => {
		const formData = await event.request.formData();
		const email = formData.get('email')?.toString() ?? '';
		const password = formData.get('password')?.toString() ?? '';

		try {
			await auth.api.signInEmail({
				body: {
					email,
					password,
					callbackURL: '/auth/verification-success'
				}
			});
		} catch (error) {
			if (error instanceof APIError) {
				return fail(400, { message: error.message || 'Signin failed' });
			}
			return fail(500, { message: 'Unexpected error' });
		}

		return redirect(302, safeRedirect(event.url));
	},
	signUpEmail: async (event) => {
		const formData = await event.request.formData();
		const email = formData.get('email')?.toString() ?? '';
		const password = formData.get('password')?.toString() ?? '';
		const name = formData.get('name')?.toString() ?? '';

		try {
			await auth.api.signUpEmail({
				body: {
					email,
					password,
					name,
					callbackURL: '/auth/verification-success'
				}
			});
		} catch (error) {
			if (error instanceof APIError) {
				return fail(400, { message: error.message || 'Registration failed' });
			}
			return fail(500, { message: 'Unexpected error' });
		}

		return redirect(302, safeRedirect(event.url));
	}
};
