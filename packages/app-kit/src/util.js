/**
 * Small pure helpers shared by the kit. No I/O.
 * @module
 */

/**
 * Default randomness (WebCrypto).
 * @param {number} length
 * @returns {Uint8Array}
 */
export const defaultRandomBytes = (length) => globalThis.crypto.getRandomValues(new Uint8Array(length));

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
