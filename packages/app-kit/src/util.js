/**
 * Small pure helpers shared by the kit. No I/O.
 * @module
 */
import { createHash } from 'node:crypto';

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * SHA-256 hex digest.
 * @param {string | Uint8Array} data
 * @returns {string}
 */
export const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');

/**
 * Base64url without padding.
 * @param {Uint8Array | string} data
 * @returns {string}
 */
export const toBase64Url = (data) => Buffer.from(data).toString('base64url');

/**
 * Default randomness (WebCrypto).
 * @param {number} length
 * @returns {Uint8Array}
 */
export const defaultRandomBytes = (length) => globalThis.crypto.getRandomValues(new Uint8Array(length));

/**
 * Random opaque token (base64url of `bytes` random bytes).
 * @param {(length: number) => Uint8Array} randomBytes
 * @param {number} [bytes]
 * @returns {string}
 */
export const randomToken = (randomBytes, bytes = 16) => toBase64Url(randomBytes(bytes));

/**
 * Deterministic JSON (keys sorted recursively) for fingerprints.
 * @param {unknown} value
 * @returns {string}
 */
export const stableJson = (value) => {
	if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
	if (isObject(value)) {
		const keys = Object.keys(value).sort();
		return `{${keys
			.filter((key) => value[key] !== undefined)
			.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
			.join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
};

const DURATION = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/**
 * Parse an ISO-8601 duration (weeks, days, hours, minutes, seconds; no years/months) to milliseconds.
 * @param {unknown} value
 * @param {number} fallback returned when `value` is absent or unparseable
 * @returns {number}
 */
export const parseDurationMs = (value, fallback) => {
	if (typeof value !== 'string' || value === 'P' || value.endsWith('T')) return fallback;
	const match = DURATION.exec(value);
	if (!match) return fallback;
	const [, w, d, h, m, s] = match.map((part) => (part === undefined ? 0 : Number(part)));
	return ((((Number(w) * 7 + Number(d)) * 24 + Number(h)) * 60 + Number(m)) * 60 + Number(s)) * 1000;
};

/**
 * Collection-safe product namespace: `ss_<slug with - → _>_`.
 * @param {string} slug
 * @returns {string}
 */
export const collectionPrefix = (slug) => `ss_${slug.replace(/-/g, '_')}_`;

/**
 * Promise-returning single-flight: concurrent calls with the same key share one in-flight promise.
 * @template T
 * @returns {(key: string, run: () => Promise<T>) => Promise<T>}
 */
export const createSingleFlight = () => {
	/** @type {Map<string, Promise<T>>} */
	const inflight = new Map();
	return (key, run) => {
		const existing = inflight.get(key);
		if (existing) return existing;
		const promise = run().finally(() => inflight.delete(key));
		inflight.set(key, promise);
		return promise;
	};
};

/**
 * Error with a stable machine `code` (and optional HTTP-ish `status`), safe to log.
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 * @returns {Error & { code: string, details?: Record<string, unknown> }}
 */
export const kitError = (code, message, details) => {
	const error = /** @type {Error & { code: string, details?: Record<string, unknown> }} */ (new Error(message));
	error.name = 'AppKitError';
	error.code = code;
	if (details) error.details = details;
	return error;
};

/**
 * @param {unknown} error
 * @param {string} [code]
 * @returns {error is Error & { code: string, details?: Record<string, unknown> }}
 */
export const isKitError = (error, code) =>
	error instanceof Error && error.name === 'AppKitError' && (code === undefined || /** @type {any} */ (error).code === code);

/**
 * Case-insensitive header read from a `Headers` instance or a plain record (arrays / duplicates → undefined).
 * @param {Headers | Record<string, string | string[] | undefined> | undefined} headers
 * @param {string} name
 * @returns {string | undefined}
 */
export const readHeader = (headers, name) => {
	if (!headers) return undefined;
	if (typeof (/** @type {Headers} */ (headers).get) === 'function') {
		return /** @type {Headers} */ (headers).get(name) ?? undefined;
	}
	const lower = name.toLowerCase();
	/** @type {string | undefined} */
	let found;
	let count = 0;
	for (const [key, value] of Object.entries(/** @type {Record<string, string | string[] | undefined>} */ (headers))) {
		if (key.toLowerCase() !== lower || value === undefined) continue;
		count += 1;
		found = Array.isArray(value) ? (value.length === 1 ? value[0] : undefined) : value;
	}
	return count === 1 ? found : undefined;
};
