/**
 * The words of a refused admin call (PLAN 0.4.10: every word a widget shows is editable in Settings → Texts). A
 * problem's `detail` is the server's English, so the admin widgets never show it: they show the website's text for the
 * field a refused form names (`problem.field.<name>`, the deepest named part of its path first, so `/variants/0/price`
 * is the price), else for the problem code (`problem.<code>`), else a general text the caller picks by the answer.
 * @module
 */

/**
 * The key of the website's text for a refusal, or null when it has none.
 * @param {Readonly<Record<string, string>>} texts the widget texts
 * @param {string} code the problem code ('' for none)
 * @param {unknown} [errors] the problem's `errors`: a refused form names its field in the first one's `path`
 * @returns {string | null}
 */
export const problemKey = (texts, code, errors) => {
	const path = code === 'validation_failed' && Array.isArray(errors) ? errors[0]?.path : undefined;
	const names =
		typeof path === 'string'
			? path
					.split('/')
					.filter((part) => /^[A-Za-z]\w*$/.test(part))
					.reverse()
			: [];
	const keys = [...names.map((name) => `problem.field.${name}`), ...(code ? [`problem.${code}`] : [])];
	return keys.find((key) => Object.hasOwn(texts, key)) ?? null;
};
