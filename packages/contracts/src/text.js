/**
 * Text helpers every unit shares (`@ss/contracts/text`): HTML escaping. Pure and browser-safe (no Node.js imports), so
 * servers, products' `core/` and widget bundles use the same code.
 * @module
 */

/** The characters HTML gives a meaning, as decimal character references (valid in HTML, XML and SVG alike). */
const HTML_SPECIAL = /[&<>"']/g;

/**
 * Text safe inside an HTML (or XML) element and inside a quoted attribute: `&`, `<`, `>`, `"` and `'` become `&#38;`,
 * `&#60;`, `&#62;`, `&#34;` and `&#39;`. Null and undefined become ''; any other value its `String` form.
 * @param {unknown} value
 * @returns {string}
 */
export const escapeHtml = (value) =>
	String(value ?? '').replace(HTML_SPECIAL, (char) => `&#${/** @type {string} */ (char).charCodeAt(0)};`);
