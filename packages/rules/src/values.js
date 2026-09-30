/**
 * Runtime value model. Values are plain data: null, boolean, finite number, string, list (array), map (plain object)
 * and date (`Date`). Anything else read from a context (undefined, functions, symbols, bigints, NaN, ±Infinity,
 * invalid dates) is treated as null. Properties are read as own *data* properties only — getters are never invoked
 * and the prototype chain is never consulted.
 */

import { parseIso } from './time.js';

/** Keys that are never readable, even if a context object has them as own properties. */
export const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** @typedef {'null' | 'boolean' | 'number' | 'string' | 'list' | 'map' | 'date'} Kind */

/**
 * @param {unknown} v
 * @returns {Kind}
 */
export function kindOf(v) {
	switch (typeof v) {
		case 'boolean':
			return 'boolean';
		case 'number':
			return Number.isFinite(v) ? 'number' : 'null';
		case 'string':
			return 'string';
		case 'object':
			if (v === null) return 'null';
			if (Array.isArray(v)) return 'list';
			if (v instanceof Date) return Number.isNaN(v.getTime()) ? 'null' : 'date';
			return 'map';
		default:
			return 'null';
	}
}

/** @param {unknown} v @returns {v is number} */
export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
/** @param {unknown} v @returns {v is string} */
export const isStr = (v) => typeof v === 'string';
/** @param {unknown} v @returns {v is unknown[]} */
export const isList = (v) => Array.isArray(v);
/** @param {unknown} v @returns {v is Date} */
export const isDate = (v) => v instanceof Date && !Number.isNaN(v.getTime());
/** @param {unknown} v @returns {v is Record<string, unknown>} */
export const isMap = (v) => kindOf(v) === 'map';
/** @param {unknown} v @returns {v is null} */
export const isNull = (v) => kindOf(v) === 'null';

/**
 * @param {unknown} v
 * @returns {unknown} `v`, or null when `v` is not a language value.
 */
export function norm(v) {
	return kindOf(v) === 'null' ? null : v;
}

/**
 * Read an own data property (never a getter, never the prototype chain).
 * @param {object} obj
 * @param {string} key
 * @returns {unknown}
 */
export function readOwn(obj, key) {
	if (FORBIDDEN_KEYS.has(key)) return null;
	const d = Object.getOwnPropertyDescriptor(obj, key);
	return d !== undefined && 'value' in d ? norm(d.value) : null;
}

/**
 * `obj.key` — maps only; everything else yields null.
 * @param {unknown} obj
 * @param {string} key
 * @returns {unknown}
 */
export function readKey(obj, key) {
	return isMap(obj) ? readOwn(obj, key) : null;
}

/**
 * `obj[index]` — list by integer (negative counts from the end) or map by string/number key.
 * @param {unknown} obj
 * @param {unknown} index
 * @returns {unknown}
 */
export function readIndex(obj, index) {
	if (isList(obj)) {
		if (!isNum(index) || !Number.isInteger(index)) return null;
		const i = index < 0 ? obj.length + index : index;
		return i >= 0 && i < obj.length ? readOwn(obj, String(i)) : null;
	}
	if (isMap(obj)) {
		if (isStr(index)) return readOwn(obj, index);
		if (isNum(index)) return readOwn(obj, String(index));
	}
	return null;
}

/**
 * Item `i` of a list (own data property).
 * @param {unknown[]} list
 * @param {number} i
 * @returns {unknown}
 */
export function itemAt(list, i) {
	return readOwn(list, String(i));
}

/**
 * Own enumerable string keys of a map, minus forbidden keys.
 * @param {Record<string, unknown>} map
 * @returns {string[]}
 */
export function mapKeys(map) {
	return Object.keys(map).filter((k) => !FORBIDDEN_KEYS.has(k));
}

/**
 * Truthiness used by `and`, `or`, `not`, `?:` and conditions: null, false, 0, '', [] and {} are falsy.
 * @param {unknown} v
 * @returns {boolean}
 */
export function truthy(v) {
	switch (kindOf(v)) {
		case 'null':
			return false;
		case 'boolean':
			return v === true;
		case 'number':
			return v !== 0;
		case 'string':
			return v !== '';
		case 'list':
			return /** @type {unknown[]} */ (v).length > 0;
		case 'map':
			return mapKeys(/** @type {Record<string, unknown>} */ (v)).length > 0;
		default:
			return true;
	}
}

/**
 * Coerce a date-like value to epoch ms: a Date, a finite number (epoch ms) or an ISO-8601 string.
 * @param {unknown} v
 * @returns {number | null}
 */
export function toMs(v) {
	if (isDate(v)) return v.getTime();
	if (isNum(v)) return v;
	if (isStr(v)) return v.length <= 40 ? parseIso(v) : null;
	return null;
}

/**
 * Three-way ordering, or null when the values are not comparable. Numbers with numbers, strings with strings
 * (UTF-16 code-unit order), and dates with anything date-like (Date, epoch ms, ISO string).
 * @param {unknown} a
 * @param {unknown} b
 * @returns {-1 | 0 | 1 | null}
 */
export function compareValues(a, b) {
	if (isDate(a) || isDate(b)) {
		const x = toMs(a);
		const y = toMs(b);
		if (x === null || y === null) return null;
		return x < y ? -1 : x > y ? 1 : 0;
	}
	if ((isNum(a) && isNum(b)) || (isStr(a) && isStr(b))) return a < b ? -1 : a > b ? 1 : 0;
	return null;
}

/**
 * Structural equality. Charges one step per compared value via `tick`; gives up (false) below depth 32.
 * @param {unknown} a
 * @param {unknown} b
 * @param {(n: number) => void} tick
 * @param {number} [depth]
 * @returns {boolean}
 */
export function deepEqual(a, b, tick, depth = 0) {
	tick(1);
	if (depth > 32) return false;
	const ka = kindOf(a);
	const kb = kindOf(b);
	if (ka === 'null' || kb === 'null') return ka === kb;
	if (ka === 'date' || kb === 'date') {
		const x = toMs(a);
		return x !== null && x === toMs(b);
	}
	if (ka !== kb) return false;
	if (isList(a) && isList(b)) {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) if (!deepEqual(itemAt(a, i), itemAt(b, i), tick, depth + 1)) return false;
		return true;
	}
	if (isMap(a) && isMap(b)) {
		const keys = mapKeys(a);
		if (keys.length !== mapKeys(b).length) return false;
		for (const k of keys) {
			if (!Object.hasOwn(b, k)) return false;
			if (!deepEqual(readOwn(a, k), readOwn(b, k), tick, depth + 1)) return false;
		}
		return true;
	}
	return a === b;
}
