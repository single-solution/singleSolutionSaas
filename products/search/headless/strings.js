/**
 * String-catalog helpers: flat keys (`notes.title`), `{name}` placeholders. Pure; safe in any runtime.
 */

/**
 * Create a translator over a resolved catalog. Missing keys return the key itself so gaps are visible, never blank.
 * @param {Readonly<Record<string, string>>} strings
 * @returns {(key: string, params?: Readonly<Record<string, string | number>>) => string}
 */
export const createTranslator =
	(strings) =>
	(key, params = {}) => {
		const template = Object.hasOwn(strings, key) ? /** @type {string} */ (strings[key]) : key;
		return template.replace(/\{([A-Za-z_]\w*)\}/g, (match, name) =>
			Object.hasOwn(params, name) ? String(params[name]) : match,
		);
	};
