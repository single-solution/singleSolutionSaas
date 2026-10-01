/**
 * Text helpers (pure): Unicode-aware normalisation and tokenisation for retrieval and phrase matching, `{name}`
 * template filling, truncation on code points and path globs (`*` = one segment, `**` = any).
 * @module
 */

/** Scripts written without spaces: indexed as character bigrams. */
const UNSPACED =
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/**
 * Lower-case, Unicode NFKC, combining marks removed (`é` → `e`), whitespace collapsed.
 * @param {unknown} text
 * @returns {string}
 */
export const normalise = (text) =>
	typeof text === 'string'
		? text
				.normalize('NFKD')
				.replace(/\p{M}+/gu, '')
				.normalize('NFKC')
				.toLowerCase()
				.replace(/\s+/g, ' ')
				.trim()
		: '';

/**
 * Words (letters and digits of any script); unspaced scripts become overlapping character bigrams.
 * @param {unknown} text
 * @param {{ minLength?: number, max?: number }} [options]
 * @returns {string[]}
 */
export const tokenize = (text, { minLength = 2, max = 20_000 } = {}) => {
	/** @type {string[]} */
	const out = [];
	for (const match of normalise(text).matchAll(/[\p{L}\p{N}]+/gu)) {
		const word = match[0];
		if (UNSPACED.test(word)) {
			const chars = [...word];
			if (chars.length === 1) out.push(word);
			for (let i = 0; i + 1 < chars.length; i += 1) out.push(`${chars[i]}${chars[i + 1]}`);
		} else if ([...word].length >= minLength || /^\p{N}+$/u.test(word)) out.push(word);
		if (out.length >= max) break;
	}
	return out.slice(0, max);
};

/**
 * Does the text contain the phrase as whole words (normalised, any script)?
 * @param {string} text
 * @param {string} phrase
 */
export const containsPhrase = (text, phrase) => {
	const haystack = ` ${tokenize(text, { minLength: 1 }).join(' ')} `;
	const needle = tokenize(phrase, { minLength: 1 }).join(' ');
	return needle.length > 0 && haystack.includes(` ${needle} `);
};

/**
 * Fill `{name}` / `{a.b}` placeholders from a context; unknown ones are left as they are.
 * @param {string} template
 * @param {Record<string, unknown>} context
 * @returns {string}
 */
export const fill = (template, context) =>
	String(template).replace(/\{([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\}/g, (match, path) => {
		let value = /** @type {unknown} */ (context);
		for (const key of String(path).split('.')) {
			if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return match;
			value = /** @type {Record<string, unknown>} */ (value)[key];
		}
		return value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
	});

/**
 * At most `max` code points (no broken surrogate pairs); `ellipsis` appended when cut.
 * @param {unknown} text
 * @param {number} max
 * @param {string} [ellipsis]
 */
export const truncate = (text, max, ellipsis = '…') => {
	const chars = [...(typeof text === 'string' ? text : String(text ?? ''))];
	if (chars.length <= max) return chars.join('');
	return `${chars.slice(0, Math.max(0, max - ellipsis.length)).join('')}${ellipsis}`;
};

/**
 * Code-point length.
 * @param {string} text
 */
export const length = (text) => [...text].length;

/**
 * Path glob match: `*` = one segment, `**` = any number of segments; trailing slashes and queries ignored.
 * @param {string} pattern
 * @param {string} path
 */
export const pathMatches = (pattern, path) => {
	const split = (/** @type {string} */ value) =>
		value
			.split(/[?#]/)[0]
			?.split('/')
			.filter((segment) => segment.length > 0) ?? [];
	const p = split(pattern);
	const s = split(path);
	/** @param {number} i @param {number} j @returns {boolean} */
	const match = (i, j) => {
		if (i === p.length) return j === s.length;
		const part = p[i];
		if (part === '**') return match(i + 1, j) || (j < s.length && match(i, j + 1));
		if (j === s.length) return false;
		const segment = /** @type {string} */ (s[j]);
		if (part === '*' || part === segment) return match(i + 1, j + 1);
		if (part?.includes('*')) {
			const [head = '', tail = ''] = part.split('*', 2);
			return segment.startsWith(head) && segment.endsWith(tail) && segment.length >= head.length + tail.length
				? match(i + 1, j + 1)
				: false;
		}
		return false;
	};
	return match(0, 0);
};

/**
 * Is the value a non-empty string after trimming?
 * @param {unknown} value
 * @returns {value is string}
 */
export const isText = (value) => typeof value === 'string' && value.trim().length > 0;
