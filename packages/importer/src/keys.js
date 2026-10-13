/**
 * Record keys (PLAN 0.8.10 K10, IMP-21): each import collection finds its records by a key — `id` by default, or other
 * top-level fields (`key`, `customerId`, `userId`, `day` + `part` …). The products note the key of every record an
 * import wrote as a text (the kit's rule, repeated here: the value of a one-field key, else the values joined by
 * U+001F) and prune ranges of those texts in MongoDB's string order (UTF-8 bytes), so `send --prune` sorts the keys it
 * keeps the same way.
 * @module
 */
import { isId } from '@ss/contracts';

/** Joins the values of a key of several fields. */
const SEPARATOR = '\u001f';
/** A key value: text without control characters, at most 200 characters. */
// eslint-disable-next-line no-control-regex
const KEY_TEXT = /^[^\u0000-\u001f]{1,200}$/;
/** Key fields: top-level field names. */
export const KEY_FIELD = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
/** The key of a collection that names none. */
export const DEFAULT_KEY = Object.freeze(['id']);

/**
 * The values of a record's key, or null when a field is missing or holds no key value (an `id` key must be an id).
 * @param {unknown} record
 * @param {ReadonlyArray<string>} fields
 * @returns {Array<string | number> | null}
 */
export const keyValuesOf = (record, fields) => {
	if (typeof record !== 'object' || record === null || Array.isArray(record)) return null;
	/** @type {Array<string | number>} */
	const values = [];
	for (const field of fields) {
		const value = /** @type {Record<string, unknown>} */ (record)[field];
		if (fields.length === 1 && field === 'id') {
			if (!isId(value)) return null;
		} else if (!(typeof value === 'string' && KEY_TEXT.test(value)) && !(Number.isSafeInteger(value) && Number(value) >= 0))
			return null;
		values.push(/** @type {string | number} */ (value));
	}
	return values;
};

/**
 * The text of a key's values, as the products note it.
 * @param {ReadonlyArray<string | number>} values
 */
export const keyTextOf = (values) => values.map(String).join(SEPARATOR);

/**
 * Order of key texts as MongoDB compares strings (UTF-8 bytes).
 * @param {string} a
 * @param {string} b
 */
export const compareKeyTexts = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/**
 * What a prune call names a key by: the value of a one-field key, else an object of the key's fields.
 * @param {ReadonlyArray<string>} fields
 * @param {ReadonlyArray<string | number>} values
 * @returns {string | number | Record<string, string | number>}
 */
export const keyPayloadOf = (fields, values) =>
	fields.length === 1
		? /** @type {string | number} */ (values[0])
		: Object.fromEntries(fields.map((field, i) => [field, /** @type {string | number} */ (values[i])]));
