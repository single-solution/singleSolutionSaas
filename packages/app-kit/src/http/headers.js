/**
 * Security headers of the product's dashboard page (PLAN 0.4.3: neither product dashboards nor the Portal can be shown
 * inside frames), for `headers()` in the product's `next.config.js`:
 *
 *   import { dashboardHeaders } from '@ss/app-kit/headers';
 *   const config = { …, headers: async () => dashboardHeaders() };
 *
 * The page refuses every frame (`X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`), so no
 * other site can lay it under its own page and steer an admin's or a merchant's clicks, and it gets the Portal's other
 * static headers (`@ss/net` `staticSecurityHeaders`): HTTPS only, no type sniffing, a short referrer, no powerful browser features, its own browsing
 * context group, no DNS prefetching and no cross-domain policy files. The policy names no sources, so the page still
 * loads its scripts, styles and the Portal's logo. The kit's API answers set their own headers (dashboard API and
 * `/sso` answers refuse frames too).
 * @module
 */

import { staticSecurityHeaders } from '@ss/net';

/** The dashboard page and everything under it (Next.js matches `/dashboard` itself too). */
const DASHBOARD = '/dashboard/:path*';

/** The dashboard page's own policy: no frames, plugins, base URL or form posts elsewhere; no source list. */
const CONTENT_SECURITY_POLICY = "frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'";

/**
 * The `headers()` answer of a product's `next.config.js`: the dashboard page's security headers (its policy and
 * `@ss/net`'s static security headers, a fresh copy each call).
 * @returns {Array<{ source: string, headers: Array<{ key: string, value: string }> }>}
 */
export const dashboardHeaders = () => [
	{
		source: DASHBOARD,
		headers: [{ key: 'Content-Security-Policy', value: CONTENT_SECURITY_POLICY }, ...staticSecurityHeaders()],
	},
];
