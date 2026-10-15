// The server side of both consoles: the request's in-process API client bound to its cookies (one per request), the
// Branding and query-string reading. Thin adapter over src/console (no business logic here).
import { cache } from 'react';
import { headers } from 'next/headers';
import { createConsoleApi } from '../../src/console/api.js';
import { DEFAULT_SETTINGS } from '../../src/infra/config.js';
import { getPortal } from '../../src/runtime.js';

/** The request's API client (one per request). */
export const portalApi = cache(async () => {
	const h = await headers(); // first: makes the page dynamic before the Portal (environment) is touched
	const portal = await getPortal();
	return createConsoleApi({
		handle: portal.handle,
		baseUrl: portal.config.portalUrl, // PORTAL_URL, never the request's headers (PLAN 0.8.1)
		cookie: h.get('cookie'),
		forwardedFor: h.get('x-forwarded-for'),
	});
});

/** The Branding and support contact (public); the defaults while they cannot be read. */
export const portalBranding = cache(async () => {
	const result = await (await portalApi()).get('/v1/branding');
	if (result.ok) return result.data;
	const { branding, support } = DEFAULT_SETTINGS;
	return { name: branding.name, accent: branding.accent, logoUrl: null, support: { ...support } };
});

/**
 * The first value of a query-string parameter.
 * @param {unknown} value
 */
export const one = (value) =>
	typeof value === 'string' ? value : Array.isArray(value) && typeof value[0] === 'string' ? value[0] : undefined;
