/**
 * Small pure helpers shared by every PDP element: bounded readers for untrusted values (page attributes, merchant
 * JSON, entitlement config), URL safety and `{placeholder}` templates. No I/O, no DOM, no clock.
 * @module
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
export const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Trimmed text of a string or finite number, capped at `max` characters (code points); `''` for anything else.
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export const text = (value, max = 500) => {
	const raw = typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
	const trimmed = raw.replace(/\s+/g, ' ').trim();
	const chars = [...trimmed];
	return chars.length > max ? chars.slice(0, max).join('') : trimmed;
};

/**
 * Integer within bounds, else the fallback.
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
export const int = (value, min, max, fallback) => {
	const parsed = typeof value === 'string' && /^-?\d{1,9}$/.test(value.trim()) ? Number(value) : value;
	return typeof parsed === 'number' && Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
};

/**
 * One of the allowed values, else the fallback.
 * @template {string} T
 * @param {unknown} value
 * @param {readonly T[]} allowed
 * @param {T} fallback
 * @returns {T}
 */
export const oneOf = (value, allowed, fallback) =>
	allowed.includes(/** @type {T} */ (value)) ? /** @type {T} */ (value) : fallback;

/**
 * @param {unknown} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
export const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

/**
 * The allowed members of a list (deduplicated, in order), else the fallback.
 * @template {string} T
 * @param {unknown} value
 * @param {readonly T[]} allowed
 * @param {readonly T[]} fallback
 * @returns {T[]}
 */
export const someOf = (value, allowed, fallback) =>
	Array.isArray(value) ? [...new Set(value.filter((entry) => allowed.includes(entry)))] : [...fallback];

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

/**
 * A URL that is safe to put in `href`/`src`: `https:`/`http:` absolute URLs and relative references only — never
 * `javascript:`, `data:` or other schemes. Returns `''` when unsafe or longer than 2048 characters.
 * @param {unknown} value
 * @returns {string}
 */
export const safeUrl = (value) => {
	const url = text(value, 2049);
	if (url === '' || url.length > 2048 || /[\s<>"'`\\]/.test(url)) return '';
	const scheme = SCHEME.exec(url)?.[1]?.toLowerCase();
	if (scheme === undefined) return url.startsWith('//') ? '' : url;
	return scheme === 'https' || scheme === 'http' ? url : '';
};

/**
 * True for an absolute `https:` URL (merchant JSON sources).
 * @param {string} url
 * @returns {boolean}
 */
export const isHttpsUrl = (url) => /^https:\/\/[^/\s?#]+/i.test(url) && safeUrl(url) === url;

/**
 * Fill `{name}` placeholders of a URL template with URL-encoded parameters (unknown names become empty).
 * @param {string} template
 * @param {Readonly<Record<string, unknown>>} params
 * @returns {string}
 */
export const fillUrl = (template, params) =>
	template.replace(/\{([A-Za-z_]\w*)\}/g, (_match, name) =>
		encodeURIComponent(Object.hasOwn(params, name) ? text(params[name], 500) : ''),
	);

/**
 * Value at a dot path (`data.items.0.name`) of untrusted JSON; at most 12 segments, own properties only.
 * @param {unknown} root
 * @param {string} path
 * @returns {unknown}
 */
export const pick = (root, path) => {
	if (path === '') return root;
	const parts = path.split('.');
	if (parts.length > 12) return undefined;
	/** @type {unknown} */
	let node = root;
	for (const part of parts) {
		if (Array.isArray(node) && /^\d{1,4}$/.test(part)) node = node[Number(part)];
		else if (isObject(node) && Object.hasOwn(node, part)) node = node[part];
		else return undefined;
	}
	return node;
};
