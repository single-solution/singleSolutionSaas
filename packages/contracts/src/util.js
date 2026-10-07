/**
 * Small pure helpers shared inside @ss/contracts.
 * @module
 */

/**
 * Recursively freeze a plain JSON-like value and return it (same reference, typed as readonly).
 * @template T
 * @param {T} value
 * @returns {T}
 */
export const deepFreeze = (value) => {
	if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const key of Object.keys(value)) deepFreeze(/** @type {Record<string, unknown>} */ (value)[key]);
	}
	return value;
};

/**
 * Escape one JSON Pointer reference token (RFC 6901).
 * @param {string | number} token
 * @returns {string}
 */
export const escapePointerToken = (token) => String(token).replace(/~/g, '~0').replace(/\//g, '~1');

/**
 * Build a JSON Pointer from reference tokens.
 * @param {ReadonlyArray<string | number>} tokens
 * @returns {string}
 */
export const pointer = (tokens) => tokens.map((token) => `/${escapePointerToken(token)}`).join('');

/**
 * True for non-null, non-array objects.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/**
 * True when `iso` is a real ISO-8601 UTC timestamp (rejects e.g. Feb 30 and non-`Z` offsets).
 * @param {unknown} iso
 * @returns {iso is string}
 */
export const isUtcTimestamp = (iso) => {
	if (typeof iso !== 'string' || !UTC_TIMESTAMP.test(iso)) return false;
	const [date = '', time = ''] = iso.slice(0, -1).split('T');
	const [y = 0, mo = 0, d = 0] = date.split('-').map(Number);
	const [h = 0, mi = 0, s = 0] = time.split(':').map((part) => Number.parseInt(part, 10));
	const parsed = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
	return (
		parsed.getUTCFullYear() === y &&
		parsed.getUTCMonth() === mo - 1 &&
		parsed.getUTCDate() === d &&
		parsed.getUTCHours() === h &&
		parsed.getUTCMinutes() === mi &&
		s <= 59
	);
};

/**
 * @param {string} hostname WHATWG URL hostname
 * @returns {boolean}
 */
const isLocalHostname = (hostname) =>
	hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '[::1]';

/**
 * True for an absolute service address: an `https://` URL, or an `http://` URL on `localhost`, `*.localhost`,
 * `127.0.0.1` or `[::1]` (local development). No userinfo, query or fragment.
 * @param {unknown} value
 * @returns {value is string}
 */
export const isServiceUrl = (value) => {
	if (typeof value !== 'string' || value.length > 2048 || /[\s\\]/.test(value)) return false;
	/** @type {URL} */
	let url;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || /[?#]/.test(value)) return false;
	return url.protocol === 'https:' || (url.protocol === 'http:' && isLocalHostname(url.hostname));
};

/**
 * True for an absolute path (`/docs`) or a service address ({@link isServiceUrl}).
 * @param {unknown} value
 * @returns {value is string}
 */
export const isPathOrServiceUrl = (value) =>
	typeof value === 'string' && (/^\/(?!\/)[^\s\\?#]*$/.test(value) || isServiceUrl(value));
