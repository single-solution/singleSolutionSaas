import { createHash } from 'node:crypto';

/**
 * Deterministic hashing used for document versions and bucketing.
 *
 * Decision: we use `node:crypto` SHA-256 directly. It is deterministic and performs no I/O, so the
 * functions stay referentially transparent; the only cost is that this package targets Node (the
 * Portal and app-kit), not the browser Loader. Browser code receives already-resolved documents.
 */

/** Number of buckets used for rollouts and experiments (basis points: 10 000 = 100 %). */
export const BUCKETS = 10_000;

/**
 * JSON serialisation with object keys sorted recursively (arrays keep their order).
 * `undefined` object members are dropped, like `JSON.stringify`.
 * @param {unknown} value
 * @returns {string}
 */
export const stableStringify = (value) => {
	if (value === null || typeof value !== 'object') {
		const json = JSON.stringify(value);
		return json === undefined ? 'null' : json;
	}
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
	const record = /** @type {Record<string, unknown>} */ (value);
	const members = Object.keys(record)
		.filter((key) => record[key] !== undefined)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
	return `{${members.join(',')}}`;
};

/**
 * Hex SHA-256 of a UTF-8 string.
 * @param {string} text
 * @returns {string}
 */
export const sha256Hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Deterministic bucket in `[0, buckets)` for the given identity parts
 * (`sha256(parts.join('\u0000'))`, first 48 bits, modulo `buckets`).
 * @param {readonly string[]} parts
 * @param {number} [buckets]
 * @returns {number}
 */
export const bucketOf = (parts, buckets = BUCKETS) => {
	const hex = sha256Hex(parts.join('\u0000'));
	return Number.parseInt(hex.slice(0, 12), 16) % buckets;
};

/**
 * Structural equality via {@link stableStringify}.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export const deepEqual = (a, b) => stableStringify(a) === stableStringify(b);
