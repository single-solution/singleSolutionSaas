// Server-side admin console context: the in-process API client bound to the request's cookies (the admin session
// cookie is separate from merchant sessions), the admin session, the Branding and the redirects of signed-out visitors
// and of merchants. Thin adapter over src/console/admin (no business logic here).
import { cache } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createConsoleApi } from '../../../src/console/api.js';
import { loadAdminSession } from '../../../src/console/admin/loaders.js';
import { getPortal } from '../../../src/runtime.js';

/** The request's API client (one per request). */
const adminApiClient = cache(async () => {
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

/** The signed-in admin session (one `/v1/me` call per request). */
export const adminSession = cache(async () => loadAdminSession(await adminApiClient()));

/** The Branding (public). */
export const adminBranding = cache(async () => {
	const result = await (await adminApiClient()).get('/v1/branding');
	return result.ok ? result.data : { name: 'Single Solution', accent: '#4f46e5', logoUrl: null, support: null };
});

/**
 * Signed-in admin context of a page; others go to the one sign-in page (and come back to `next`), merchants to their
 * console.
 * @param {string} next
 */
export const adminContext = async (next) => {
	const session = await adminSession();
	if (!session.ok) {
		if (session.status === 401) redirect(`/login?next=${encodeURIComponent(next)}`);
		if (/** @type {{ merchant?: boolean }} */ (session).merchant) redirect('/overview');
		throw new Error(session.problem?.detail ?? 'The admin console is unavailable.');
	}
	return { api: await adminApiClient(), admin: session.admin };
};

/** @param {unknown} value */
export const one = (value) =>
	typeof value === 'string' ? value : Array.isArray(value) && typeof value[0] === 'string' ? value[0] : undefined;
