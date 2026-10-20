/**
 * The address of the caller, as the hosting layer saw it: one helper for the Portal and every product, so a per-visitor
 * limit or a stored answer never keys on something the caller wrote.
 * @module
 */
import { isIP } from 'node:net';

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
