/**
 * Small encoding and hashing helpers shared by the protocol primitives. Node runtime (`node:crypto`).
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { base64url } from 'jose';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * UTF-8 encode a string.
 * @param {string} value
 * @returns {Uint8Array}
 */
export const utf8 = (value) => encoder.encode(value);

/**
 * Strict UTF-8 decode (throws on invalid sequences).
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export const fromUtf8 = (bytes) => decoder.decode(bytes);

/**
 * Base64url (no padding) encode.
 * @param {Uint8Array | string} value
 * @returns {string}
 */
export const b64url = (value) => base64url.encode(value);

/**
 * Base64url decode; rejects characters outside the base64url alphabet.
 * @param {string} value
 * @returns {Uint8Array}
 */
export const fromB64url = (value) => {
	if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new TypeError('invalid base64url');
	return base64url.decode(value);
};

/**
 * SHA-256 hex digest.
 * @param {Uint8Array | string} data
 * @returns {string}
 */
export const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');

/**
 * HMAC-SHA-256 hex digest.
 * @param {Uint8Array | string} key
 * @param {Uint8Array | string} data
 * @returns {string}
 */
export const hmacSha256Hex = (key, data) => createHmac('sha256', key).update(data).digest('hex');

/**
 * Constant-time equality for secrets of any length: both sides are hashed first so neither the content nor the length
 * leaks through timing.
 * @param {Uint8Array | string} a
 * @param {Uint8Array | string} b
 * @returns {boolean}
 */
export const constantTimeEqual = (a, b) => {
	const ha = createHash('sha256').update(a).digest();
	const hb = createHash('sha256').update(b).digest();
	return timingSafeEqual(ha, hb);
};

/**
 * Default randomness source (WebCrypto CSPRNG). Inject your own `randomBytes` in tests.
 * @param {number} length
 * @returns {Uint8Array}
 */
export const defaultRandomBytes = (length) => globalThis.crypto.getRandomValues(new Uint8Array(length));

/**
 * Random identifier (base64url of 16 random bytes = 128 bits).
 * @param {(length: number) => Uint8Array} randomBytes
 * @returns {string}
 */
export const randomId = (randomBytes) => b64url(randomBytes(16));

/**
 * Case-insensitive header lookup over a plain object or a WHATWG `Headers`.
 * @param {Record<string, string | string[] | undefined> | Headers | undefined | null} headers
 * @param {string} name
 * @returns {string | undefined}
 */
export const getHeader = (headers, name) => {
	if (!headers) return undefined;
	if (typeof Headers !== 'undefined' && headers instanceof Headers) return headers.get(name) ?? undefined;
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(/** @type {Record<string, string | string[] | undefined>} */ (headers))) {
		if (key.toLowerCase() !== wanted) continue;
		if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined;
		return value;
	}
	return undefined;
};

/**
 * Canonical JSON (RFC 8785 style): object keys sorted by UTF-16 code units, no whitespace, ECMAScript number and string
 * serialisation; `undefined` object members are omitted and `undefined` array items become `null` (as JSON.stringify).
 * Throws on values JSON cannot represent (non-finite numbers, functions, symbols, bigints).
 * @param {unknown} value
 * @returns {string}
 */
export const canonicalJson = (value) => {
	if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new TypeError('non-finite number is not JSON');
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
	if (typeof value === 'object') {
		const record = /** @type {Record<string, unknown>} */ (value);
		const members = Object.keys(record)
			.filter((key) => record[key] !== undefined)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
		return `{${members.join(',')}}`;
	}
	throw new TypeError(`${typeof value} is not JSON`);
};
