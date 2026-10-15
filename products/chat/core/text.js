/**
 * Text helpers (pure): Unicode-aware normalization and tokenization for retrieval and phrase matching, the words
 * around a phrase and truncation on code points; the shared path patterns (`pathMatches` of `@ss/contracts/text`), for
 * the widgets, which reach contracts helpers only through core.
 * @module
 */

export { pathMatches } from '@ss/contracts/text';

/** Scripts written without spaces: indexed as character bigrams. */
const UNSPACED =
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/**
 * True for an https address of at most 500 characters.
 * @param {unknown} value
 * @returns {value is string}
 */
export const isHttpsUrl = (value) =>
	typeof value === 'string' && value.length <= 500 && /^https:\/\/[^\s/?#]+(?:[/?#]\S*)?$/.test(value);

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
 * Does the text contain the phrase as whole words (normalized, any script)?
 * @param {string} text
 * @param {string} phrase
 */
export const containsPhrase = (text, phrase) => {
	const haystack = ` ${tokenize(text, { minLength: 1 }).join(' ')} `;
	const needle = tokenize(phrase, { minLength: 1 }).join(' ');
	return needle.length > 0 && haystack.includes(` ${needle} `);
};

/** A word that ends a sentence: `.`, `!` or `?` (or their full-width forms) last, before any closing quote or bracket. */
const SENTENCE_END = /[.!?。！？]["'”’)\]]*$/u;
/** Where a sentence ends inside text written without spaces. */
const SENTENCE_MARK = /[.!?。！？]/u;

/** A letter or digit: what is left of a word once the punctuation at its ends goes. */
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * A word without the punctuation at either end (a scan from both ends, never a pattern that slows down on a long run
 * of punctuation).
 * @param {string} word
 */
const trimEdges = (word) => {
	const chars = [...word];
	let start = 0;
	while (start < chars.length && !WORD_CHAR.test(/** @type {string} */ (chars[start]))) start += 1;
	let end = chars.length;
	while (end > start && !WORD_CHAR.test(/** @type {string} */ (chars[end - 1]))) end -= 1;
	return chars.slice(start, end).join('');
};

/**
 * The words before and after a phrase within its sentence (a line break, or a word ending in `.`, `!` or `?`, ends
 * one), at its first place with words on both sides: matched as whole words, case and accents aside, like
 * `containsPhrase`; a phrase in a script written without spaces anywhere. Words lose the punctuation at their ends.
 * @param {string} text
 * @param {string} phrase
 * @returns {{ before: string[], after: string[] } | null}
 */
export const aroundPhrase = (text, phrase) => {
	/** @param {string} part */
	const wordsOf = (part) =>
		part
			.split(/\s+/)
			.map(trimEdges)
			.filter((word) => word !== '');
	const needle = wordsOf(phrase).map(normalise);
	if (needle.length === 0) return null;
	for (const line of text.normalize('NFKC').split('\n')) {
		if (UNSPACED.test(phrase)) {
			const part = phrase.trim().normalize('NFKC');
			const at = line.indexOf(part);
			if (at < 0) continue;
			const head = line.slice(0, at);
			const tail = line.slice(at + part.length);
			const ends = [...head].findLastIndex((char) => SENTENCE_MARK.test(char));
			const stop = [...tail].findIndex((char) => SENTENCE_MARK.test(char));
			const before = wordsOf([...head].slice(ends + 1).join(''));
			const after = wordsOf(stop < 0 ? tail : [...tail].slice(0, stop).join(''));
			if (before.length > 0 && after.length > 0) return { before, after };
			continue;
		}
		const raw = line.split(/\s+/).filter((word) => trimEdges(word) !== '');
		const words = raw.map(trimEdges);
		const keys = words.map(normalise);
		const ends = raw.map((word) => SENTENCE_END.test(word));
		for (let i = 1; i + needle.length < words.length; i += 1) {
			if (!needle.every((word, j) => keys[i + j] === word)) continue;
			let first = i;
			while (first > 0 && !ends[first - 1]) first -= 1;
			let last = i + needle.length;
			while (last < words.length && !ends[last]) last += 1;
			const before = words.slice(first, i);
			const after = words.slice(i + needle.length, last + 1);
			if (before.length > 0 && after.length > 0) return { before, after };
		}
	}
	return null;
};

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
