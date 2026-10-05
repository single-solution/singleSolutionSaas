/**
 * Small pure helpers shared by the infra layer. No I/O.
 * @module
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

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
 * HMAC-SHA-256 hex digest.
 * @param {string | Uint8Array} key
 * @param {string | Uint8Array} data
 * @returns {string}
 */
export const hmacHex = (key, data) => createHmac('sha256', key).update(data).digest('hex');

/**
 * Constant-time string comparison (length differences are compared against a same-length dummy so the timing
 * does not depend on where the strings differ).
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export const safeEqual = (a, b) => {
	if (typeof a !== 'string' || typeof b !== 'string') return false;
	const left = Buffer.from(a, 'utf8');
	const right = Buffer.from(b, 'utf8');
	if (left.length !== right.length) {
		timingSafeEqual(left, left);
		return false;
	}
	return timingSafeEqual(left, right);
};

/**
 * Default randomness (WebCrypto).
 * @param {number} length
 * @returns {Uint8Array}
 */
export const defaultRandomBytes = (length) => globalThis.crypto.getRandomValues(new Uint8Array(length));

/**
 * Random opaque token, base64url of `bytes` random bytes.
 * @param {(length: number) => Uint8Array} randomBytes
 * @param {number} [bytes]
 * @returns {string}
 */
export const randomToken = (randomBytes, bytes = 32) => Buffer.from(randomBytes(bytes)).toString('base64url');

/**
 * Deterministic JSON (object keys sorted recursively, `undefined` members dropped).
 * @param {unknown} value
 * @returns {string}
 */
export const stableJson = (value) => {
	if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
	if (isObject(value) && !(value instanceof Date)) {
		return `{${Object.keys(value)
			.sort()
			.filter((key) => value[key] !== undefined)
			.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
			.join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
};

/**
 * MongoDB duplicate-key error.
 * @param {unknown} error
 * @returns {boolean}
 */
export const isDuplicateKey = (error) => isObject(error) && error.code === 11000;
