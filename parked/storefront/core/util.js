/**
 * Small pure helpers shared by every element core: typed config readers (unknown or mistyped values fall back to the
 * product default, numbers are clamped to their bounds), safe URLs and a stable hash. No I/O, no DOM.
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
export const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 */
export const int = (value, fallback, min, max) =>
	Number.isInteger(value) ? Math.min(max, Math.max(min, /** @type {number} */ (value))) : fallback;

/**
 * @param {unknown} value
 * @param {string} [fallback]
 * @param {number} [max]
 */
export const str = (value, fallback = '', max = 500) => (typeof value === 'string' ? value.trim().slice(0, max) : fallback);

/**
 * @param {unknown} value
 * @param {boolean} fallback
 */
export const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

/**
 * @template {string} T
 * @param {unknown} value
 * @param {readonly T[]} allowed
 * @param {T} fallback
 * @returns {T}
 */
export const oneOf = (value, allowed, fallback) =>
	allowed.includes(/** @type {T} */ (value)) ? /** @type {T} */ (value) : fallback;

/**
 * Non-empty strings of an array, capped in count and length.
 * @param {unknown} value
 * @param {number} [max]
 * @param {number} [length]
 * @returns {string[]}
 */
export const strings = (value, max = 50, length = 100) =>
	Array.isArray(value)
		? value
				.filter((entry) => typeof entry === 'string' && entry.trim() !== '')
				.slice(0, max)
				.map((entry) => entry.trim().slice(0, length))
		: [];

/**
 * Plain objects of an array, capped.
 * @param {unknown} value
 * @param {number} max
 * @returns {Record<string, any>[]}
 */
export const objects = (value, max) => (Array.isArray(value) ? value.filter(isObject).slice(0, max) : []);

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f\s\\]/;

/**
 * A link target: http(s), mailto, tel or a same-site relative URL (`/x`, `?q`, `#a`, `x/y`). Protocol-relative
 * (`//host`), `javascript:`, `data:` and anything with control characters or whitespace are refused.
 * @param {unknown} value
 * @param {{ src?: boolean }} [options] `src`: media sources (http(s) and relative only)
 * @returns {string | null}
 */
export const safeUrl = (value, { src = false } = {}) => {
	if (typeof value !== 'string') return null;
	const url = value.trim();
	if (url === '' || url.length > 2048 || UNSAFE.test(url) || url.startsWith('//')) return null;
	const scheme = SCHEME.exec(url)?.[1]?.toLowerCase();
	if (scheme === undefined) return url;
	return (src ? ['http', 'https'] : ['http', 'https', 'mailto', 'tel']).includes(scheme) ? url : null;
};

/**
 * Stable small hash of a seed into `[0, modulo)` (phase buckets, deterministic jitter).
 * @param {string} seed
 * @param {number} modulo
 */
export const hash = (seed, modulo) => {
	let value = 0;
	for (let index = 0; index < seed.length; index += 1) value = (value * 31 + seed.charCodeAt(index)) % 1_000_003;
	return modulo > 0 ? value % modulo : 0;
};

/**
 * Read a dotted path (`images.0.url`) from a JSON value.
 * @param {unknown} value
 * @param {string} path
 * @returns {unknown}
 */
export const at = (value, path) => {
	let current = value;
	for (const part of path.split('.')) {
		if (current === null || typeof current !== 'object') return undefined;
		current = /** @type {Record<string, unknown>} */ (current)[part];
	}
	return current;
};

/**
 * First defined value among `|`-separated alternative paths (`url|href|link`).
 * @param {unknown} value
 * @param {string} paths
 * @returns {unknown}
 */
export const first = (value, paths) => {
	for (const path of paths.split('|')) {
		const found = at(value, path.trim());
		if (found !== undefined && found !== null && found !== '') return found;
	}
	return undefined;
};
