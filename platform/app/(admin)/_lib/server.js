// Server-side Admin Console context: the in-process API client bound to the request's cookies (the staff session
// cookie is separate from merchant sessions), the staff session, the redirects of signed-out or half-signed
// (password only, MFA pending) staff, and the first-run check of the sign-in page. Thin adapter over src/console/admin (no business logic here).
import { cache } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createConsoleApi } from '../../../src/console/api.js';
import { loadStaffSession } from '../../../src/console/admin/loaders.js';
import { originFromHeaders } from '../../../src/infra/request-scope.js';
import { getPortal } from '../../../src/runtime.js';

/** The request's API client (one per request). */
export const adminApiClient = cache(async () => {
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

/** The signed-in staff session (one `/v1/me` call per request). */
export const staffSession = cache(async () => loadStaffSession(await adminApiClient()));

/**
 * Signed-in staff context of a page; others go to the staff sign-in page (and come back to `next`).
 * @param {string} next
 */
export const staffContext = async (next) => {
	const session = await staffSession();
	if (!session.ok) {
		if (session.status === 401) redirect(`/admin/login?next=${encodeURIComponent(next)}`);
		throw new Error(session.problem?.detail ?? 'The admin console is unavailable.');
	}
	return { api: await adminApiClient(), staff: session.staff };
};

/** Fully signed-in staff skip the sign-in page. */
export const redirectIfStaff = async () => {
	const session = await staffSession();
	if (session.ok) redirect('/admin/merchants');
};

/** First run: no staff user exists yet, so the sign-in page offers "Create admin". */
export const isFirstRun = async () => {
	const identity = /** @type {{ hasStaff: () => Promise<boolean> }} */ ((await getPortal()).modules.service('identity'));
	return !(await identity.hasStaff());
};

/** @param {unknown} value */
export const one = (value) =>
	typeof value === 'string' ? value : Array.isArray(value) && typeof value[0] === 'string' ? value[0] : undefined;
