// Server-side console context: the session, the redirects of signed-out visitors and of admins (who use /admin), on
// the request's API client and Branding (`app/_lib/server.js`). Thin adapter over src/console (no business logic
// here).
import { cache } from 'react';
import { redirect } from 'next/navigation';
import { loadSession } from '../../../src/console/loaders.js';
import { portalApi, portalBranding } from '../../_lib/server.js';

export { one } from '../../_lib/server.js';

/** The request's console API client (one per request). */
export const consoleApi = portalApi;

/** The Branding and support contact (public). */
export const consoleBranding = portalBranding;

/** The signed-in session (one `/v1/me` call per request). */
export const consoleSession = cache(async () => loadSession(await consoleApi()));

/**
 * Signed-in merchant context of a page; signed-out visitors go to the sign-in page and admins to their console.
 * @param {string} [next] path to come back to after signing in
 */
export const merchantContext = async (next) => {
	const session = await consoleSession();
	if (!session.ok) {
		if (session.status === 401) redirect(next ? `/login?next=${encodeURIComponent(next)}` : '/login');
		if (/** @type {{ admin?: boolean }} */ (session).admin) redirect('/admin');
		throw new Error(session.problem?.detail ?? 'The console is unavailable.');
	}
	return { api: await consoleApi(), me: session.me, merchantId: session.merchantId };
};

/** Signed-in visitors of the public pages go straight to their console (the session of the layout, no second call). */
export const redirectIfSignedIn = async () => {
	const session = await consoleSession();
	if (session.ok) redirect('/overview');
	if (/** @type {{ admin?: boolean }} */ (session).admin) redirect('/admin');
};

/** True while no admin exists (the sign-in page offers Create admin). */
export const firstAdminAvailable = async () => {
	const result = await (await consoleApi()).get('/v1/auth/first-admin');
	return result.ok && result.data?.available === true;
};
