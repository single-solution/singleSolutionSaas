/**
 * The static security headers of every page the Portal and the products serve (the Portal's `next.config.js` sets them
 * on every response, each product's on its dashboard page): HTTPS only, no type sniffing, no frames, a short referrer,
 * no powerful browser features, its own browsing context group, no DNS prefetching and no cross-domain policy files.
 * Each side adds its own Content-Security-Policy (the Portal's per-request nonce policy stays in the Portal).
 * @module
 */

/** The headers, in the order they are sent. @type {ReadonlyArray<readonly [string, string]>} */
const STATIC_SECURITY_HEADERS = Object.freeze([
	['Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload'],
	['X-Content-Type-Options', 'nosniff'],
	['X-Frame-Options', 'DENY'],
	['Referrer-Policy', 'strict-origin-when-cross-origin'],
	[
		'Permissions-Policy',
		'accelerometer=(), autoplay=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), usb=(), browsing-topics=()',
	],
	['Cross-Origin-Opener-Policy', 'same-origin'],
	['X-DNS-Prefetch-Control', 'off'],
	['X-Permitted-Cross-Domain-Policies', 'none'],
]);

/**
 * The static security headers, as `next.config.js` `headers()` takes them (a fresh copy each call).
 * @returns {Array<{ key: string, value: string }>}
 */
export const staticSecurityHeaders = () => STATIC_SECURITY_HEADERS.map(([key, value]) => ({ key, value }));
