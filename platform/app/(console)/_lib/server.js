// Server-side console context: the in-process API client bound to the request's cookies, the session, the Branding
// and the redirects of signed-out visitors and of admins (who use /admin). Thin adapter over src/console (no business
// logic here).
import { cache } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createConsoleApi } from '../../../src/console/api.js';
import { loadSession } from '../../../src/console/loaders.js';
import { getPortal } from '../../../src/runtime.js';

/** The request's console API client (one per request). */
export const consoleApi = cache(async () => {
	const h = await headers(); // first: makes the page dynamic before the Portal (environment) is touched
	const portal = await getPortal();
	return createConsoleApi({
		handle: portal.handle,
		baseUrl: portal.config.portalUrl, // PORTAL_URL, never the request's headers (PLAN 0.8.1)
		cookie: h.get('cookie'),
		forwardedFor: h.get('x-forwarded-for'),
		userAgent: h.get('user-agent'),
		perRender: true,
	});
});

/** The signed-in session (one `/v1/me` call per request). */
export const consoleSession = cache(async () => loadSession(await consoleApi()));

/** The Branding and support contact (public). */
export const consoleBranding = cache(async () => {
	const result = await (await consoleApi()).get('/v1/branding');
	return result.ok
		? result.data
		: { name: 'Single Solution', accent: '#4f46e5', logoUrl: null, support: { email: null, phone: null, whatsapp: null } };
});

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

/** @param {unknown} value */
export const one = (value) =>
	typeof value === 'string' ? value : Array.isArray(value) && typeof value[0] === 'string' ? value[0] : undefined;
