/**
 * Small value helpers every unit shares (`@ss/contracts/util`). Pure and browser-safe (no Node.js imports).
 * @module
 */

/**
 * Freeze a value all the way down and return it (the same reference). Objects are frozen before their members, so a
 * value that refers to itself is frozen once, never endlessly; typed arrays and other buffer views are left as they are
 * (JavaScript cannot freeze them while they hold elements).
 * @template T
 * @param {T} value
 * @returns {T}
 */
export const deepFreeze = (value) => {
	if (value !== null && typeof value === 'object' && !Object.isFrozen(value) && !ArrayBuffer.isView(value)) {
		Object.freeze(value);
		for (const key of Object.keys(value)) deepFreeze(/** @type {Record<string, unknown>} */ (value)[key]);
	}
	return value;
};

/**
 * True for an object that is neither null nor an array (a JSON object, a record).
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
