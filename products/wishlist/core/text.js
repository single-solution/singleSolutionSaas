/**
 * Translator over a flat catalog with `{name}` placeholders; a missing key returns itself (gaps stay visible).
 * @param {Readonly<Record<string, string>>} strings
 * @returns {(key: string, params?: Readonly<Record<string, string | number>>) => string}
 */
export const createTranslator =
	(strings) =>
	(key, params = {}) =>
		(Object.hasOwn(strings, key) ? /** @type {string} */ (strings[key]) : key).replace(/\{([A-Za-z_]\w*)\}/g, (match, name) =>
			Object.hasOwn(params, name) ? String(params[name]) : match,
		);
