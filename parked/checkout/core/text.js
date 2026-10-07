/**
 * Small, pure input helpers shared by the core: type guards, bounded text cleaning and field problems. Nothing here
 * assumes a country, language or currency.
 * @module
 */

/** Opaque ids accepted from callers (items, variants, carts, orders). */
export const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** Machine keys (fields, methods, policies). */
export const KEY = /^[a-z][a-z0-9_]{0,31}$/;
/** ISO-4217 alphabetic code. */
export const CURRENCY = /^[A-Z]{3}$/;
/** ISO-3166-1 alpha-2 code. */
export const COUNTRY = /^[A-Z]{2}$/;

/**
 * @typedef {{ path: string, code: string }} FieldProblem
 */

/** @param {unknown} value @returns {value is Record<string, any>} */
export const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** @param {unknown} value @returns {value is string} */
export const isId = (value) => typeof value === 'string' && ID.test(value);

/** @param {unknown} value @returns {value is string} */
export const isKey = (value) => typeof value === 'string' && KEY.test(value);

/** @param {unknown} value @returns {value is number} */
export const isAmount = (value) => Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0;

/**
 * Trimmed text without control characters, at most `max` characters; `null` when empty or not a string.
 * @param {unknown} value
 * @param {number} max
 * @returns {string | null}
 */
export const cleanText = (value, max) => {
	if (typeof value !== 'string') return null;
	const text = [...value.slice(0, max * 2)]
		.filter((char) => {
			const code = char.charCodeAt(0);
			return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
		})
		.join('')
		.trim();
	return text === '' ? null : text.slice(0, max);
};

/**
 * @param {string} path JSON pointer
 * @param {string} code
 * @returns {FieldProblem}
 */
export const issue = (path, code) => ({ path, code });

/**
 * A bounded integer (or the fallback when absent / invalid).
 * @param {unknown} value
 * @param {{ min: number, max: number, fallback: number }} bounds
 */
export const boundedInt = (value, { min, max, fallback }) =>
	Number.isInteger(value) ? Math.min(max, Math.max(min, /** @type {number} */ (value))) : fallback;

/** Simple e-mail shape (one at-sign, no spaces, a dot in the domain). @param {string} value */
export const isEmail = (value) => /^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/.test(value) && value.length <= 254;
