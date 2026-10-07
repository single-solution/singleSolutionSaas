/**
 * Text helpers (pure): bounded, control-character-free text, keys, ids, contact normalisation and `{placeholder}`
 * templates. Nothing here assumes a language, a country or a phone format.
 * @module
 */

/** Opaque ids (the `@ss/contracts` opaqueId pattern). */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** Merchant-defined keys (statuses, methods, reasons). */
export const KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** @param {unknown} value @returns {value is Record<string, any>} */
export const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** @param {unknown} value @returns {value is string} */
export const isId = (value) => typeof value === 'string' && ID_PATTERN.test(value);

/** @param {unknown} value @returns {value is string} */
export const isKey = (value) => typeof value === 'string' && KEY_PATTERN.test(value);

/** @param {unknown} value */
export const isNil = (value) => value === null || value === undefined;

/**
 * Trimmed text without control characters (line breaks kept when `multiline`), or null when empty or too long.
 * @param {unknown} value
 * @param {number} max
 * @param {{ multiline?: boolean }} [options]
 * @returns {string | null}
 */
export const cleanText = (value, max, { multiline = false } = {}) => {
	if (typeof value !== 'string' && typeof value !== 'number') return null;
	const raw = String(value);
	const flat = multiline ? raw.replace(/\r\n?/g, '\n') : raw.replace(/[\r\n\t]+/g, ' ');
	const text = flat.replace(CONTROL, '').trim();
	return text.length === 0 || text.length > max ? null : text;
};

/**
 * A lowercased e-mail address, or null.
 * @param {unknown} value
 * @returns {string | null}
 */
export const normalizeEmail = (value) => {
	const text = cleanText(value, 320);
	return text && EMAIL.test(text) ? text.toLowerCase() : null;
};

/**
 * A phone number reduced to its digits (a leading `+` kept), or null when it has fewer than 4 or more than 15 digits.
 * No country is assumed: `+44 20 …` and `020 …` stay different numbers unless the merchant matches on the last digits.
 * @param {unknown} value
 * @returns {string | null}
 */
export const normalizePhone = (value) => {
	const text = cleanText(value, 40);
	if (!text) return null;
	const digits = text.replace(/\D/g, '');
	if (digits.length < 4 || digits.length > 15) return null;
	return text.startsWith('+') ? `+${digits}` : digits;
};

/**
 * The digits a phone number is matched on: all of them, or the last `digits` (A16 lesson: normalise before matching).
 * @param {string} phone normalised
 * @param {number} digits 0 = all
 */
export const phoneMatchKey = (phone, digits) => {
	const bare = phone.replace(/\D/g, '');
	return digits > 0 ? bare.slice(-digits) : bare;
};

/**
 * Fill `{name}` placeholders (unknown names stay as written; null / undefined values become empty).
 * @param {string} template
 * @param {Readonly<Record<string, string | number | null | undefined>>} values
 */
export const fill = (template, values) =>
	template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => {
		if (!Object.hasOwn(values, name)) return match;
		const value = values[name];
		return value === undefined || value === null ? '' : String(value);
	});

/**
 * A field problem.
 * @param {string} path JSON pointer-ish path (`/lines/0/quantity`)
 * @param {string} code
 * @returns {{ path: string, code: string }}
 */
export const issue = (path, code) => ({ path, code });

/**
 * An https:// URL without credentials (≤ 2048 characters), or null.
 * @param {unknown} value
 * @returns {string | null}
 */
export const httpsUrl = (value) => {
	const text = cleanText(value, 2048);
	if (!text) return null;
	try {
		const url = new URL(text);
		return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
	} catch {
		return null;
	}
};

/**
 * Parse a list of ids from `a,b,c` (deduplicated, order kept); null when one is invalid or there are too many.
 * @param {unknown} raw
 * @param {number} max
 * @returns {string[] | null}
 */
export const idList = (raw, max) => {
	const parts = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : null;
	if (!parts) return null;
	/** @type {string[]} */
	const out = [];
	for (const part of parts) {
		const id = typeof part === 'string' ? part.trim() : '';
		if (id === '') continue;
		if (!isId(id)) return null;
		if (!out.includes(id)) out.push(id);
	}
	return out.length === 0 || out.length > max ? null : out;
};
