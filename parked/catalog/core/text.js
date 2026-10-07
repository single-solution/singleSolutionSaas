/**
 * Text helpers (pure): bounded, control-character-free text, keys, ids, slugs and `{placeholder}` templates. Nothing
 * here assumes a language: slugs keep letters of every script.
 * @module
 */

/** Opaque ids (the `@ss/contracts` opaqueId pattern). */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** Merchant-defined keys (attributes, custom fields, statuses, types, feeds). */
export const KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
/** Slugs: lowercase letters of any script, digits, single dashes. */
export const SLUG_PATTERN = /^[\p{Ll}\p{Lo}\p{N}]+(?:-[\p{Ll}\p{Lo}\p{N}]+)*$/u;
/** Longest slug. */
export const MAX_SLUG = 120;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** @param {unknown} value */
export const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** @param {unknown} value */
export const isId = (value) => typeof value === 'string' && ID_PATTERN.test(value);

/** @param {unknown} value */
export const isKey = (value) => typeof value === 'string' && KEY_PATTERN.test(value);

/** @param {unknown} value */
export const isSlug = (value) => typeof value === 'string' && value.length <= MAX_SLUG && SLUG_PATTERN.test(value);

/**
 * Trimmed text without control characters (line breaks kept when `multiline`), or null when empty or too long.
 * @param {unknown} value
 * @param {number} max
 * @param {{ multiline?: boolean }} [options]
 * @returns {string | null}
 */
export const cleanText = (value, max, { multiline = false } = {}) => {
	if (typeof value !== 'string') return null;
	const flat = multiline ? value.replace(/\r\n?/g, '\n') : value.replace(/[\r\n\t]+/g, ' ');
	const text = flat.replace(CONTROL, '').trim();
	return text.length === 0 || text.length > max ? null : text;
};

/**
 * A slug from any text: lowercase, accents folded, every run of other characters becomes one dash.
 * @param {unknown} text
 * @param {number} [max]
 * @returns {string}
 */
export const slugify = (text, max = MAX_SLUG) =>
	String(text ?? '')
		.normalize('NFKD')
		.replace(/\p{M}+/gu, '')
		.toLowerCase()
		.replace(/[^\p{Ll}\p{Lo}\p{N}]+/gu, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, max)
		.replace(/-+$/g, '');

/**
 * Fill `{name}` placeholders (unknown names stay as written).
 * @param {string} template
 * @param {Readonly<Record<string, string | number | null | undefined>>} values
 */
export const fill = (template, values) =>
	template.replace(/\{([A-Za-z_][A-Za-z0-9_.]*)\}/g, (match, name) => {
		const value = Object.hasOwn(values, name) ? values[name] : undefined;
		return value === undefined || value === null ? (Object.hasOwn(values, name) ? '' : match) : String(value);
	});

/**
 * Distinct, bounded list of clean strings (null when not a list or too long).
 * @param {unknown} value
 * @param {{ max: number, itemMax: number, check?: (text: string) => boolean }} options
 * @returns {string[] | null}
 */
export const textList = (value, { max, itemMax, check = () => true }) => {
	if (!Array.isArray(value) || value.length > max) return null;
	/** @type {string[]} */
	const out = [];
	for (const entry of value) {
		const text = cleanText(entry, itemMax);
		if (text === null || !check(text)) return null;
		if (!out.includes(text)) out.push(text);
	}
	return out;
};

/** @param {unknown} value */
export const isNil = (value) => value === null || value === undefined;

/**
 * SEO title and description (null clears a field).
 * @param {Record<string, unknown>} input
 * @returns {{ problems: Array<{ path: string, code: string }>, value: { title: string | null, description: string | null } }}
 */
export const seoOf = (input) => {
	const title = isNil(input.title) ? null : cleanText(input.title, 200);
	const description = isNil(input.description) ? null : cleanText(input.description, 500);
	return {
		problems: [
			...(!isNil(input.title) && title === null ? [issue('/seo/title', 'text_invalid')] : []),
			...(!isNil(input.description) && description === null ? [issue('/seo/description', 'text_invalid')] : []),
		],
		value: { title, description },
	};
};

/**
 * A field problem.
 * @param {string} path JSON pointer-ish path (`/variants/0/price`)
 * @param {string} code
 * @returns {{ path: string, code: string }}
 */
export const issue = (path, code) => ({ path, code });
