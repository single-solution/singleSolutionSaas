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
