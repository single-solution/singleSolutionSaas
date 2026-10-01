/**
 * HTTP security headers (pure). `next.config.js` applies the static set to every response; `proxy.js` adds a
 * per-request nonce-based CSP to HTML pages (Next.js applies the nonce to its own scripts and styles).
 *
 * - Pages: `script-src 'self' 'nonce-…' 'strict-dynamic'` (+ `'unsafe-eval'` in development only, for React
 *   debugging), `style-src 'self' 'nonce-…'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'self'`,
 *   `frame-ancestors 'none'`, `upgrade-insecure-requests` (not on plain-http localhost).
 * - API / JSON / anything without a proxy-issued policy: `default-src 'none'; frame-ancestors 'none'`.
 * @module
 */

/**
 * Content-Security-Policy for an HTML page.
 * @param {{ nonce: string, dev?: boolean, upgradeInsecure?: boolean }} options
 */
export const pageCsp = ({ nonce, dev = false, upgradeInsecure = true }) => {
	if (!/^[A-Za-z0-9+/=_-]{16,128}$/.test(nonce)) throw new TypeError('invalid CSP nonce');
	return [
		"default-src 'self'",
		`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
		`style-src 'self' 'nonce-${nonce}'`,
		"img-src 'self' blob: data:",
		"font-src 'self'",
		`connect-src 'self'${dev ? ' ws: wss:' : ''}`,
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'self'",
		"frame-ancestors 'none'",
		...(upgradeInsecure ? ['upgrade-insecure-requests'] : []),
	].join('; ');
};

/** Policy for API and other non-HTML responses. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * Fresh nonce (128 bits, base64).
 * @param {(n: number) => Uint8Array} [randomBytes]
 */
export const createNonce = (randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))) =>
	Buffer.from(randomBytes(16)).toString('base64');

/**
 * Static headers for every response.
 * @param {{ hsts?: boolean }} [options]
 * @returns {Array<{ key: string, value: string }>}
 */
export const staticSecurityHeaders = ({ hsts = true } = {}) => [
	...(hsts ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' }] : []),
	{ key: 'X-Content-Type-Options', value: 'nosniff' },
	{ key: 'X-Frame-Options', value: 'DENY' },
	{ key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
	{
		key: 'Permissions-Policy',
		value: 'accelerometer=(), autoplay=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), usb=(), browsing-topics=()',
	},
	{ key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
	{ key: 'X-DNS-Prefetch-Control', value: 'off' },
	{ key: 'X-Permitted-Cross-Domain-Policies', value: 'none' },
];
