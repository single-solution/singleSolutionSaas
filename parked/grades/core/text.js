/**
 * Small pure helpers for identifiers and text (no I/O).
 * @module
 */

/** Opaque ids (`@ss/contracts` opaqueId): item, variant, unit and serial ids from any system. */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** Keys of tiers, checklists, checklist items and vocabularies. */
export const KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export const isId = (value) => typeof value === 'string' && ID_PATTERN.test(value);

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export const isKey = (value) => typeof value === 'string' && KEY_PATTERN.test(value);

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
export const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** C0/C1 control characters except tab and newline. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/**
 * Trimmed text without control characters, capped at `max` characters; null when empty or not a string.
 * @param {unknown} value
 * @param {number} max
 * @returns {string | null}
 */
export const cleanText = (value, max) => {
	if (typeof value !== 'string') return null;
	const text = value.replace(CONTROL, '').trim();
	return text.length === 0 ? null : text.slice(0, max);
};

/**
 * `{name}` placeholders replaced from `params`; unknown placeholders stay visible.
 * @param {string} template
 * @param {Readonly<Record<string, string | number>>} params
 */
export const fill = (template, params) =>
	template.replace(/\{([A-Za-z_]\w*)\}/g, (match, name) => (Object.hasOwn(params, name) ? String(params[name]) : match));

/** @typedef {(key: string, params?: Readonly<Record<string, string | number>>) => string} Translate */

/**
 * A translator over a flat catalog (missing keys return the key, so gaps stay visible).
 * @param {Readonly<Record<string, string>>} catalog
 * @returns {Translate}
 */
export const translator =
	(catalog) =>
	(key, params = {}) =>
		fill(Object.hasOwn(catalog, key) ? /** @type {string} */ (catalog[key]) : key, params);
