// Server-side console context: the in-process API client bound to the request's cookies, the session, and the
// redirects of signed-out users. Thin adapter over src/console (no business logic here).
import { cache } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createConsoleApi } from '../../../src/console/api.js';
import { loadSession } from '../../../src/console/loaders.js';
import { originFromHeaders } from '../../../src/infra/request-scope.js';
import { getPortal } from '../../../src/runtime.js';

/** The request's console API client (one per request). */
export const consoleApi = cache(async () => {
	const h = await headers(); // first: makes the page dynamic before the Portal (environment) is touched
	const portal = await getPortal();
	return createConsoleApi({
		handle: portal.handle,
		baseUrl: originFromHeaders(h, 'http://localhost'), // the Portal's address is the request's own origin
		cookie: h.get('cookie'),
		forwardedFor: h.get('x-forwarded-for'),
		userAgent: h.get('user-agent'),
	});
});

/** The signed-in session (one `/v1/me` call per request). */
export const consoleSession = cache(async () => loadSession(await consoleApi()));

/**
 * Signed-in merchant context of a page; signed-out visitors go to the sign-in page.
 * @param {string} [next] path to come back to after signing in
 */
export const merchantContext = async (next) => {
	const session = await consoleSession();
	if (!session.ok) {
		if (session.status === 401) redirect(next ? `/login?next=${encodeURIComponent(next)}` : '/login');
		throw new Error(session.problem?.detail ?? 'The console is unavailable.');
	}
	if (!session.merchantId) redirect('/account');
	return { api: await consoleApi(), me: session.me, merchantId: /** @type {string} */ (session.merchantId) };
};

/** Signed-in visitors of the public auth pages go straight to the console. */
export const redirectIfSignedIn = async () => {
	const session = await consoleSession();
	if (session.ok) redirect('/websites');
};

/** @param {unknown} value */
export const one = (value) =>
	typeof value === 'string' ? value : Array.isArray(value) && typeof value[0] === 'string' ? value[0] : undefined;
