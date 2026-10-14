/**
 * Path patterns of the merchant's settings (the notice bar's hidden pages), on their own so the page script carries
 * only this and none of the settings code. No imports, no I/O.
 * @module
 */

/**
 * Whether a page's path matches a path pattern: an exact path, `*` one segment, `**` any number of segments (the query
 * string and fragment are ignored; `/` is the home page).
 * @param {string} pattern
 * @param {string} path
 */
export const pathMatches = (pattern, path) => {
	const split = (/** @type {string} */ value) =>
		(value.split(/[?#]/)[0] ?? '').split('/').filter((segment) => segment.length > 0);
	const p = split(pattern.trim());
	const s = split(path);
	/** @param {number} i @param {number} j @returns {boolean} */
	const match = (i, j) => {
		if (i === p.length) return j === s.length;
		const part = p[i];
		if (part === '**') return match(i + 1, j) || (j < s.length && match(i, j + 1));
		if (j === s.length) return false;
		return (part === '*' || part === s[j]) && match(i + 1, j + 1);
	};
	return pattern.trim().startsWith('/') && match(0, 0);
};
