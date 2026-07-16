import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

// Gate the whole dashboard behind an authenticated session.
export const load: LayoutServerLoad = ({ locals, url }) => {
	if (!locals.user) {
		return redirect(302, `/demo/better-auth/login?redirect=${encodeURIComponent(url.pathname)}`);
	}
	return { user: locals.user };
};
