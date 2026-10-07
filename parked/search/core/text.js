/**
 * Text analysis shared by indexing and querying (pure, language-neutral): Unicode normalisation (compatibility forms,
 * marks removed, lower case), tokens of letters and digits (ideographs and kana one per token, because those scripts
 * do not separate words with spaces), letter/digit splits for indexing (`iphone13` → `iphone13`, `iphone`, `13`),
 * trigrams for typo candidates and a bounded edit distance (optimal string alignment: insert, delete, substitute,
 * swap two neighbours).
 * @module
 */

/** Longest token kept (longer runs are cut). */
export const MAX_TOKEN = 40;

const WORD = /[\p{L}\p{N}]+/gu;
const SPACELESS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const SPACELESS_RUN =
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu;
const LETTER_DIGIT = /\p{L}+|\p{N}+/gu;

/**
 * Normalised text: NFKD, combining marks removed, lower case, whitespace collapsed.
 * @param {unknown} value
 * @returns {string}
 */
export const normalise = (value) =>
	String(value ?? '')
		.normalize('NFKD')
		.replace(/\p{M}+/gu, '')
		.toLowerCase()
		.replace(/\s+/gu, ' ')
		.trim();

/** @param {string} token */
const cut = (token) => [...token].slice(0, MAX_TOKEN).join('');

/**
 * Tokens of a text, in order (duplicates kept).
 * @param {unknown} value
 * @returns {string[]}
 */
export const tokenize = (value) => {
	/** @type {string[]} */
	const out = [];
	for (const word of normalise(value).match(WORD) ?? []) {
		if (!SPACELESS.test(word)) {
			out.push(cut(word));
			continue;
		}
		for (const part of word.match(SPACELESS_RUN) ?? []) out.push(cut(part));
	}
	return out;
};

/**
 * Index terms of a token: the token and, when it mixes letters and digits, its letter and digit runs.
 * @param {string} token
 * @returns {string[]}
 */
export const termVariants = (token) => {
	const parts = token.match(LETTER_DIGIT) ?? [];
	return parts.length > 1 ? [token, ...parts] : [token];
};

/**
 * Trigrams of a term with boundary marks (`^ab`, `abc`, `bc$`), unique.
 * @param {string} term
 * @returns {string[]}
 */
export const trigrams = (term) => {
	const chars = [...`^${term}$`];
	if (chars.length <= 3) return [chars.join('')];
	/** @type {Set<string>} */
	const out = new Set();
	for (let index = 0; index + 3 <= chars.length; index += 1) out.add(chars.slice(index, index + 3).join(''));
	return [...out];
};

/**
 * Edit distance between two terms, bounded: returns `max + 1` as soon as the distance must exceed `max`.
 * @param {string} a
 * @param {string} b
 * @param {number} max
 * @returns {number}
 */
export const editDistance = (a, b, max) => {
	const s = [...a];
	const t = [...b];
	if (Math.abs(s.length - t.length) > max) return max + 1;
	if (s.length === 0 || t.length === 0) return Math.min(Math.max(s.length, t.length), max + 1);
	/** @type {number[]} */
	let before = [];
	/** @type {number[]} */
	let previous = Array.from({ length: t.length + 1 }, (_, j) => j);
	for (let i = 1; i <= s.length; i += 1) {
		const current = [i];
		let best = i;
		for (let j = 1; j <= t.length; j += 1) {
			const cost = s[i - 1] === t[j - 1] ? 0 : 1;
			let value = Math.min(
				/** @type {number} */ (previous[j]) + 1,
				/** @type {number} */ (current[j - 1]) + 1,
				/** @type {number} */ (previous[j - 1]) + cost,
			);
			if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1])
				value = Math.min(value, /** @type {number} */ (before[j - 2]) + 1);
			current.push(value);
			best = Math.min(best, value);
		}
		if (best > max) return max + 1;
		before = previous;
		previous = current;
	}
	return Math.min(/** @type {number} */ (previous[t.length]), max + 1);
};

/**
 * Plain text of an HTML fragment for indexing (tags dropped, the common entities decoded, whitespace collapsed).
 * Never rendered: the result is indexed and shown only as text.
 * @param {string} html
 * @returns {string}
 */
export const htmlText = (html) =>
	String(html)
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ')
		.replace(/<[^>]*>/g, ' ')
		.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|amp|lt|gt|quot|apos|nbsp);/gi, (entity, body) => decodeEntity(String(body)))
		.replace(/\s+/g, ' ')
		.trim();

/** @param {string} body */
const decodeEntity = (body) => {
	const named = /** @type {Record<string, string>} */ ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' });
	const lower = body.toLowerCase();
	if (lower in named) return /** @type {string} */ (named[lower]);
	const code = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
	return Number.isInteger(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
		? String.fromCodePoint(code)
		: ' ';
};

/**
 * Text cut to at most `max` characters (code points), on a word boundary when one is near.
 * @param {string} text
 * @param {number} max
 */
export const clip = (text, max) => {
	const chars = [...text];
	if (chars.length <= max) return text;
	const head = chars.slice(0, max).join('');
	const space = head.lastIndexOf(' ');
	return space > max * 0.8 ? head.slice(0, space) : head;
};
