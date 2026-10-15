/**
 * Small pure helpers shared by the infra layer and the modules. No I/O.
 * @module
 */
import { isObject } from '@ss/contracts/util';

/**
 * Default randomness (WebCrypto).
 * @param {number} length
 * @returns {Uint8Array}
 */
export const defaultRandomBytes = (length) => globalThis.crypto.getRandomValues(new Uint8Array(length));

/**
 * True when the text holds a control character (C0 or DEL).
 * @param {string} text
 */
export const hasControlCharacters = (text) => [...text].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);

/**
 * Midnight (UTC, ms) of a day `YYYY-MM-DD` the calendar has, else null (`2026-02-31` never becomes March 3).
 * @param {unknown} value
 * @returns {number | null}
 */
export const utcDayStart = (value) => {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
	const ms = Date.parse(`${value}T00:00:00Z`);
	return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms : null;
};

/**
 * MongoDB duplicate-key error.
 * @param {unknown} error
 * @returns {boolean}
 */
export const isDuplicateKey = (error) => isObject(error) && error.code === 11000;
