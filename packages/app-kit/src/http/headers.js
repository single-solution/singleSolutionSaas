/**
 * Security headers of the product's dashboard page (PLAN 0.4.3: neither product dashboards nor the Portal can be shown
 * inside frames), for `headers()` in the product's `next.config.js`:
 *
 *   import { dashboardHeaders } from '@ss/app-kit/headers';
 *   const config = { …, headers: async () => dashboardHeaders() };
 *
 * The page refuses every frame (`X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`), so no
 * other site can lay it under its own page and steer an admin's or a merchant's clicks, and it gets the Portal's other
 * static headers: HTTPS only, no type sniffing, a short referrer, no powerful browser features, its own browsing
 * context group, no DNS prefetching and no cross-domain policy files. The policy names no sources, so the page still
 * loads its scripts, styles and the Portal's logo. The kit's API answers set their own headers (dashboard API and
 * `/sso` answers refuse frames too).
 * @module
 */

/** The dashboard page and everything under it (Next.js matches `/dashboard` itself too). */
const DASHBOARD = '/dashboard/:path*';

/** The headers of the dashboard page. */
const DASHBOARD_HEADERS = Object.freeze(
	[
		{ key: 'Content-Security-Policy', value: "frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'" },
		{ key: 'X-Frame-Options', value: 'DENY' },
		{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
		{ key: 'X-Content-Type-Options', value: 'nosniff' },
		{ key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
		{
			key: 'Permissions-Policy',
			value: 'accelerometer=(), autoplay=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), usb=(), browsing-topics=()',
		},
		{ key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
		{ key: 'X-DNS-Prefetch-Control', value: 'off' },
		{ key: 'X-Permitted-Cross-Domain-Policies', value: 'none' },
	].map((header) => Object.freeze(header)),
);

/**
 * The `headers()` answer of a product's `next.config.js`: the dashboard page's security headers.
 * @returns {Array<{ source: string, headers: Array<{ key: string, value: string }> }>}
 */
export const dashboardHeaders = () => [{ source: DASHBOARD, headers: DASHBOARD_HEADERS.map((header) => ({ ...header })) }];
