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
const toBase64Url = (data) => Buffer.from(data).toString('base64url');

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
 * Merchant database collection prefix of a product: `ss_<product id with - → _>_`.
 * @param {string} productId
 * @returns {string}
 */
export const collectionPrefix = (productId) => `ss_${productId.replace(/-/g, '_')}_`;

/**
 * A copy of an object without some members.
 * @template {Record<string, any>} T
 * @param {T} value
 * @param {ReadonlyArray<string>} keys
 * @returns {Record<string, any>}
 */
export const omit = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));

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
