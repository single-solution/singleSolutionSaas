/**
 * Internal helpers (not part of the public API). Browser globals are read through `globalThis` so every module also
 * loads outside the browser (server rendering, tests).
 * @module
 */

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/**
 * @callback RandomBytes
 * @param {number} length
 * @returns {Uint8Array}
 */

/** @type {RandomBytes} */
export const defaultRandomBytes = (length) => globalThis.crypto.getRandomValues(new Uint8Array(length));

/**
 * A platform-style opaque id: `<prefix>_` + 128 random bits as 26 lowercase Crockford base32 characters
 * (the same shape as `@ss/contracts` `createId`, duplicated here to keep widget scripts small).
 * @param {string} prefix
 * @param {RandomBytes} [randomBytes]
 * @returns {string}
 */
export const createId = (prefix, randomBytes = defaultRandomBytes) => {
	let out = '';
	let buffer = 0;
	let bits = 0;
	for (const byte of randomBytes(16)) {
		buffer = (buffer << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += ALPHABET[(buffer >>> (bits - 5)) & 31];
			bits -= 5;
		}
		buffer &= (1 << bits) - 1;
	}
	return `${prefix}_${out}${ALPHABET[(buffer << (5 - bits)) & 31]}`;
};

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export const isPlainObject = (value) => {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
};
