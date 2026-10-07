/**
 * Widget text helpers shared by the server and the browser entry (no Node.js imports).
 * @module
 */

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]{0,63})\}/g;

/**
 * The placeholder names of a text, sorted and unique (`'Hi {name}, {count} new'` → `['count', 'name']`).
 * @param {string} text
 * @returns {string[]}
 */
export const placeholdersOf = (text) =>
	[...new Set([...String(text).matchAll(PLACEHOLDER)].map((match) => String(match[1])))].sort();

/**
 * True when two texts carry exactly the same placeholders.
 * @param {string} a
 * @param {string} b
 */
export const samePlaceholders = (a, b) => placeholdersOf(a).join('\n') === placeholdersOf(b).join('\n');

/**
 * Fill a widget text's `{placeholders}`. Unknown placeholders stay as they are. The result is plain text: set it with
 * `textContent`, never as HTML.
 * @param {string} text
 * @param {Record<string, string | number>} [values]
 * @returns {string}
 */
export const formatText = (text, values = {}) =>
	String(text).replace(PLACEHOLDER, (whole, name) => (Object.hasOwn(values, name) ? String(values[name]) : whole));
