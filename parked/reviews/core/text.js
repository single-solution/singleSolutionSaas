/**
 * Customer-authored text (pure): sanitation, link counting, blocked-term matching and public author names.
 * Ported from ibrahimMobiles `@store/shared` reviews (`sanitizeReviewText`, `reviewerDisplayName`), generalised: no
 * language or region is assumed — blocked terms are the merchant's own list, matched on Unicode word boundaries.
 * Review text is always rendered as text, never as HTML.
 * @module
 */

// eslint-disable-next-line no-control-regex -- stripping control and bidi-override characters is the point
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;
const WORD = /[\p{L}\p{N}\p{M}]+/gu;
/** Scripts written without spaces between words: blocked terms in them match as substrings. */
const UNSPACED =
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const LINK = /\bhttps?:\/\/[^\s]+|\bwww\.[^\s]+/giu;

/**
 * Plain-text sanitation: removes control / bidi-override characters and anything tag-shaped, normalises line breaks
 * (at most one blank line), collapses runs of spaces and caps the length.
 * @param {unknown} input
 * @param {number} maxLength
 * @returns {string}
 */
export const sanitizeText = (input, maxLength) => {
	if (typeof input !== 'string') return '';
	return input
		.normalize('NFC')
		.replace(/\r\n?/g, '\n')
		.replace(CONTROL_CHARS, '')
		.replace(/<[^>]*>/g, '')
		.replace(/[<>]/g, '')
		.replace(/[ \t]+/g, ' ')
		.replace(/ *\n */g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim()
		.slice(0, Math.max(0, maxLength))
		.trim();
};

/**
 * Sanitised single-line text (titles, names).
 * @param {unknown} input
 * @param {number} maxLength
 */
export const singleLine = (input, maxLength) => sanitizeText(input, maxLength).replace(/\n+/g, ' ');

/**
 * Number of links (`http(s)://…` or `www.…`) in a text.
 * @param {string} text
 * @returns {number}
 */
export const countLinks = (text) => (text.match(LINK) ?? []).length;

/**
 * Lower-cased words of a text (Unicode letters, digits and marks).
 * @param {string} text
 * @returns {string[]}
 */
export const words = (text) => text.normalize('NFKC').toLocaleLowerCase('und').match(WORD) ?? [];

/**
 * The merchant's blocked terms found in a text: whole words (a phrase matches consecutive words), or substrings for
 * terms written in scripts without word separators. At most 10 are reported.
 * @param {string} text
 * @param {readonly string[]} terms
 * @returns {string[]}
 */
export const findBlockedTerms = (text, terms) => {
	if (terms.length === 0 || text.length === 0) return [];
	const tokens = words(text);
	const folded = text.normalize('NFKC').toLocaleLowerCase('und');
	/** @type {string[]} */
	const found = [];
	for (const term of terms) {
		if (found.length >= 10) break;
		const parts = words(term);
		if (parts.length === 0) continue;
		const hit = UNSPACED.test(term)
			? folded.includes(term.normalize('NFKC').toLocaleLowerCase('und').trim())
			: tokens.some((_, start) => parts.every((part, offset) => tokens[start + offset] === part));
		if (hit && !found.includes(term)) found.push(term);
	}
	return found;
};

/** Public author name formats (`collection.reviewer_name`). */
export const NAME_FORMATS = Object.freeze(/** @type {const} */ (['first_name_initial', 'first_name', 'full_name', 'initials']));

/**
 * Public attribution from a full name: "Ayesha Khan" → "Ayesha K." (first_name_initial), "Ayesha", "Ayesha Khan" or
 * "A. K.". Null when there is no name (the renderer shows its own anonymous label).
 * @param {string | null | undefined} fullName
 * @param {(typeof NAME_FORMATS)[number]} format
 * @param {number} [maxLength]
 * @returns {string | null}
 */
export const displayName = (fullName, format, maxLength = 60) => {
	const parts = singleLine(fullName ?? '', maxLength)
		.split(/\s+/)
		.filter(Boolean);
	if (parts.length === 0) return null;
	const first = /** @type {string} */ (parts[0]);
	const last = parts.length > 1 ? /** @type {string} */ (parts[parts.length - 1]) : null;
	const initial = (/** @type {string} */ word) => `${[...word][0]?.toLocaleUpperCase('und') ?? ''}.`;
	switch (format) {
		case 'first_name':
			return first;
		case 'full_name':
			return parts.join(' ');
		case 'initials':
			return [first, ...(last ? [last] : [])].map(initial).join(' ');
		default:
			return last ? `${first} ${initial(last)}` : first;
	}
};
