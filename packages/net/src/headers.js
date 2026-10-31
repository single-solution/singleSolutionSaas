/**
 * HTTP header helpers shared by the Portal and products: static security headers and client IP extraction.
 * @module
 */
import { isIP } from 'node:net';

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

/** @param {string | null | undefined} value @returns {string | null} an IP address, else null */
const addressOf = (value) => {
	const trimmed = (value ?? '').trim();
	return isIP(trimmed) === 0 ? null : trimmed;
};

/**
 * The caller's IP address: the hosting platform's own header first (`X-Real-IP`, which Vercel sets itself), else the
 * LAST `X-Forwarded-For` hop (the one our own proxy appended; the first values are whatever the caller wrote), else null
 * (the caller keeps its `unknown` bucket). A value that is not an IP address is never used, so no caller makes buckets
 * of its own with text.
 * @param {Headers} headers the request's headers
 * @returns {string | null}
 */
export const clientIpOf = (headers) =>
	addressOf(headers.get('x-real-ip')) ?? addressOf(headers.get('x-forwarded-for')?.split(',').at(-1));
